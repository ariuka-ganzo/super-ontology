import { createWriteStream } from 'node:fs';
import readExcelFile from 'read-excel-file/node';

type Cell = string | number | boolean | Date | null | undefined;

/** Sheet names in an .xlsx file. */
export async function excelSheets(path: string): Promise<string[]> {
  const sheets = await readExcelFile(path);
  return sheets.map((s) => s.sheet);
}

/**
 * Reads one sheet of an .xlsx file (the first when `sheet` is not given) and writes it as CSV,
 * so DuckDB can infer column types the same way it does for CSV files. Everything runs locally.
 */
export async function readExcelToCsv(path: string, outPath: string, sheet?: string): Promise<void> {
  const sheets = await readExcelFile(path);
  const found = sheet ? sheets.find((s) => s.sheet === sheet) : sheets[0];
  if (!found) throw new Error(sheet ? `Sheet "${sheet}" not found` : 'The workbook has no sheets');
  const data = found.data as Cell[][];
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
  const out = createWriteStream(outPath, { encoding: 'utf8' });
  const write = (line: string): Promise<void> =>
    new Promise((resolve, reject) => (out.write(line) ? resolve() : out.once('drain', resolve)) && out.once('error', reject));
  await write(header.map(cell).join(',') + '\n');
  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    await write(Array.from({ length: width }, (_, i) => cell(row[i])).join(',') + '\n');
  }
  await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
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
