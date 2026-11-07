import { promises as fs } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { writeChunks } from '../write';

type Cell = string | number | boolean | Date | null | undefined;

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * Sheet names in an .xlsx file, in workbook order. Only `xl/workbook.xml` is decompressed, so no
 * sheet data is parsed just to list the sheets.
 */
export async function excelSheets(path: string): Promise<string[]> {
  const zip = unzipSync(new Uint8Array(await fs.readFile(path)), { filter: (f) => f.name === 'xl/workbook.xml' });
  const xml = zip['xl/workbook.xml'];
  if (!xml) throw new Error('This is not an Excel workbook (xl/workbook.xml is missing)');
  const names = [...strFromU8(xml).matchAll(/<(?:\w+:)?sheet\b[^>]*?\bname="([^"]*)"/g)].map((m) => decodeXml(m[1]));
  if (names.length === 0) throw new Error('The workbook has no sheets');
  return names;
}

/**
 * Reads one sheet of an .xlsx file (the first when `sheet` is not given) and writes it as CSV,
 * so DuckDB can infer column types the same way it does for CSV files. Only that sheet is parsed.
 */
export async function readExcelToCsv(path: string, outPath: string, sheet?: string): Promise<void> {
  const data = (sheet ? await readSheet(path, sheet) : await readSheet(path)) as Cell[][];
  if (data.length === 0) throw new Error('The sheet is empty');
  const width = Math.max(...data.map((r) => r.length));
  const seen = new Map<string, number>();
  const header = Array.from({ length: width }, (_, i) => {
    const raw = data[0][i];
    let name = raw === null || raw === undefined || String(raw).trim() === '' ? `Column ${i + 1}` : String(raw).trim();
    const count = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), count + 1);
    if (count > 0) name = `${name} (${count + 1})`;
    return name;
  });
  function* lines(): Generator<string> {
    yield header.map(cell).join(',') + '\n';
    for (let r = 1; r < data.length; r++) {
      const row = data[r];
      yield Array.from({ length: width }, (_, i) => cell(row[i])).join(',') + '\n';
    }
  }
  await writeChunks(outPath, lines());
}

function cell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.slice(0, 19).replace('T', ' ');
  }
  const s = String(v);
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}
