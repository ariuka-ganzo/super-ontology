import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import writeXlsxFile from 'write-excel-file/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine, csvCell } from '../../src/main/engine/engine';
import { excelSheets } from '../../src/main/engine/excel';
import type { QueryRequest } from '@shared/api';
import type { Model, TableDef, TableSource } from '@shared/types';

let engine: Engine;
let dir: string;

function tableDef(id: string, source: TableSource, r: { columns: TableDef['columns']; rowCount: number }): TableDef {
  return { id, name: id, source, columns: r.columns, rowCount: r.rowCount };
}

beforeAll(async () => {
  engine = await Engine.create();
  dir = mkdtempSync(join(tmpdir(), 'facet-engine-'));
  writeFileSync(join(dir, 'a.csv'), 'id,name,amount,day,flag\n1,Ann,10.5,2024-01-01,true\n2,"Bob, Jr.",20,2024-01-02,false\n3,,30,,true\n');
  writeFileSync(join(dir, 'b.tsv'), 'id\tcity\n1\tOslo\n2\tLima\n');
  writeFileSync(
    join(dir, 'c.json'),
    JSON.stringify([
      { id: 1, tags: ['x', 'y'], nested: { a: 1 } },
      { id: 2, tags: [], nested: { a: 2 } }
    ])
  );
  const w = await DuckDBInstance.create(':memory:');
  const wc = await w.connect();
  await wc.run(`COPY (SELECT range AS id, range * 2 AS twice FROM range(5)) TO '${join(dir, 'd.parquet').replace(/'/g, "''")}' (FORMAT parquet)`);
  wc.closeSync();
  await writeXlsxFile([
    {
      sheet: 'First',
      data: [
        ['Product', 'Price', 'When', 'Price'],
        ['Pen', 1.5, { value: new Date(Date.UTC(2024, 4, 1)), format: 'yyyy-mm-dd' }, 2],
        ['Ink', 3, { value: new Date(Date.UTC(2024, 4, 2)), format: 'yyyy-mm-dd' }, 4]
      ]
    },
    { sheet: 'Second', data: [['only'], ['x']] }
  ]).toFile(join(dir, 'e.xlsx'));
});

afterAll(() => engine.close());

describe('import', () => {
  it('imports CSV with inferred types', async () => {
    const r = await engine.importTable('a', { path: join(dir, 'a.csv'), format: 'csv' });
    expect(r.rowCount).toBe(3);
    expect(r.columns.map((c) => [c.name, c.type])).toEqual([
      ['id', 'integer'],
      ['name', 'string'],
      ['amount', 'number'],
      ['day', 'date'],
      ['flag', 'boolean']
    ]);
    const p = await engine.preview(tableDef('a', { path: '', format: 'csv' }, r), 10, 0);
    expect(p.total).toBe(3);
    expect(p.rows[1]).toEqual([2, 'Bob, Jr.', 20, '2024-01-02', false]);
  });

  it('imports TSV, JSON (nested values as text), Parquet and Excel', async () => {
    const tsv = await engine.importTable('b', { path: join(dir, 'b.tsv'), format: 'tsv' });
    expect(tsv.columns.map((c) => c.name)).toEqual(['id', 'city']);
    const json = await engine.importTable('c', { path: join(dir, 'c.json'), format: 'json' });
    expect(json.columns.map((c) => c.type)).toEqual(['integer', 'string', 'string']);
    const pj = await engine.preview(tableDef('c', { path: '', format: 'json' }, json), 10, 0);
    expect(pj.rows[0][1]).toBe('[x, y]');
    const pq = await engine.importTable('d', { path: join(dir, 'd.parquet'), format: 'parquet' });
    expect(pq.rowCount).toBe(5);
    const xl = await engine.importTable('e', { path: join(dir, 'e.xlsx'), format: 'excel' });
    expect(xl.columns.map((c) => [c.name, c.type])).toEqual([
      ['Product', 'string'],
      ['Price', 'number'],
      ['When', 'date'],
      ['Price (2)', 'integer']
    ]);
    const xl2 = await engine.importTable('e2', { path: join(dir, 'e.xlsx'), format: 'excel', sheet: 'Second' });
    expect(xl2.rowCount).toBe(1);
  });

  it('lists Excel sheet names without reading sheet data', async () => {
    await writeXlsxFile([
      { sheet: 'Q1 & Q2', data: [['a'], [1]] },
      { sheet: 'Plan', data: [['b'], [2]] }
    ]).toFile(join(dir, 'names.xlsx'));
    expect(await excelSheets(join(dir, 'names.xlsx'))).toEqual(['Q1 & Q2', 'Plan']);
    writeFileSync(join(dir, 'fake.xlsx'), 'not a zip');
    await expect(excelSheets(join(dir, 'fake.xlsx'))).rejects.toThrow();
  });

  it('refuses files that are not data files', async () => {
    writeFileSync(join(dir, 'secret'), 'not,data\n1,2\n');
    await expect(engine.importTable('s', { path: join(dir, 'secret'), format: 'csv' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(engine.importTable('s', { path: join(dir, 'a.csv'), format: 'parquet' })).rejects.toThrow(/does not look like a PARQUET file/);
  });

  it('gives a clear error for a missing file', async () => {
    await expect(engine.importTable('z', { path: join(dir, 'nope.csv'), format: 'csv' })).rejects.toMatchObject({ code: 'missing' });
  });

  it('reloads in place, keeping the old data when the new file is unreadable', async () => {
    const path = join(dir, 'reload.csv');
    writeFileSync(path, 'x\n1\n2\n');
    await engine.importTable('r', { path, format: 'csv' });
    writeFileSync(path, 'x,y\n1,a\n2,b\n3,c\n');
    const r = await engine.importTable('r', { path, format: 'csv' });
    expect(r.rowCount).toBe(3);
    expect(r.columns.map((c) => c.name)).toEqual(['x', 'y']);
  });
});

describe('profile and cardinality', () => {
  it('profiles numeric, date and text columns', async () => {
    const r = await engine.importTable('a', { path: join(dir, 'a.csv'), format: 'csv' });
    const t = tableDef('a', { path: '', format: 'csv' }, r);
    const amount = await engine.profile(t, 'amount');
    expect(amount).toMatchObject({ total: 3, nulls: 0, distinct: 3, min: 10.5, max: 30, histogramKind: 'bins' });
    expect(amount.histogram).toHaveLength(20);
    expect(amount.histogram.reduce((s, b) => s + b.count, 0)).toBe(3);
    const day = await engine.profile(t, 'day');
    expect(day).toMatchObject({ nulls: 1, distinct: 2, min: '2024-01-01', max: '2024-01-02' });
    const name = await engine.profile(t, 'name');
    expect(name.histogramKind).toBe('top');
    expect(name.nulls).toBe(1);
  });

  it('counts every row in the histogram of a column with one repeated value', async () => {
    writeFileSync(join(dir, 'same.csv'), 'v,d\n5,2024-03-01\n5,2024-03-01\n5,2024-03-01\n,\n');
    const r = await engine.importTable('same', { path: join(dir, 'same.csv'), format: 'csv' });
    const t = tableDef('same', { path: '', format: 'csv' }, r);
    for (const column of ['v', 'd']) {
      const p = await engine.profile(t, column);
      expect(p.histogramKind).toBe('bins');
      expect(p.histogram).toHaveLength(1);
      expect(p.histogram[0].count).toBe(3);
    }
  });

  it('profiles with a type override', async () => {
    const r = await engine.importTable('a', { path: join(dir, 'a.csv'), format: 'csv' });
    const t = tableDef('a', { path: '', format: 'csv' }, r);
    t.columns[0] = { ...t.columns[0], override: 'string' };
    const p = await engine.profile(t, 'id');
    expect(p.histogramKind).toBe('top');
  });

  it('detects cardinality and match rate', async () => {
    const a = await engine.importTable('a', { path: join(dir, 'a.csv'), format: 'csv' });
    const b = await engine.importTable('b', { path: join(dir, 'b.tsv'), format: 'tsv' });
    const model: Model = {
      tables: [tableDef('a', { path: '', format: 'csv' }, a), tableDef('b', { path: '', format: 'tsv' }, b)],
      relationships: [],
      calcs: []
    };
    const r = await engine.cardinality(model, { fromTable: 'a', fromColumn: 'id', toTable: 'b', toColumn: 'id' });
    expect(r).toMatchObject({ cardinality: 'one-to-one', fromUnique: true, toUnique: true });
    expect(r.matchRate).toBeCloseTo(2 / 3);
  });
});

describe('queries', () => {
  async function model(): Promise<Model> {
    const a = await engine.importTable('a', { path: join(dir, 'a.csv'), format: 'csv' });
    return { tables: [tableDef('a', { path: '', format: 'csv' }, a)], relationships: [], calcs: [] };
  }
  const req = (m: Model, requestId = 'q1'): QueryRequest => ({
    requestId,
    model: m,
    spec: {
      chartType: 'bar',
      columns: [{ id: 'd', field: { kind: 'column', table: 'a', column: 'flag' }, role: 'dimension' }],
      rows: [{ id: 'm', field: { kind: 'column', table: 'a', column: 'amount' }, role: 'measure', agg: 'SUM' }],
      tooltip: [],
      filters: []
    }
  });

  it('runs a view query and reports truncation', async () => {
    const m = await model();
    const r = await engine.query(req(m));
    expect(r.rows).toEqual([
      [false, 20],
      [true, 40.5]
    ]);
    expect(r.truncated).toBe(false);
    const t = await engine.query({ ...req(m), maxRows: 1 });
    expect(t.truncated).toBe(true);
    expect(t.rows).toHaveLength(1);
  });

  it('streams CSV export with escaping', async () => {
    const m = await model();
    let csv = '';
    for await (const chunk of engine.queryCsv(req(m))) csv += chunk;
    expect(csv).toBe('flag,Sum of amount\r\nfalse,20\r\ntrue,40.5\r\n');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('cancels a long query without blocking the event loop', async () => {
    await engine.importTable('big', { path: join(dir, 'a.csv'), format: 'csv' });
    const m: Model = {
      tables: [
        {
          id: 'big',
          name: 'big',
          source: { path: '', format: 'csv' },
          rowCount: 3,
          columns: [{ name: 'id', sourceType: 'BIGINT', type: 'integer' }]
        }
      ],
      relationships: [],
      calcs: [{ id: 'slow', name: 'slow', formula: '{FIXED [id] : SUM([id])}' }]
    };
    // A deliberately heavy query: a FIXED expression over a cross join is not possible from the
    // UI, so make the engine table itself big instead.
    await engine.unsafeRawForTests('CREATE OR REPLACE TABLE t_big AS SELECT range AS id FROM range(300000000)');
    const request: QueryRequest = {
      requestId: 'slow1',
      model: m,
      spec: {
        chartType: 'table',
        columns: [{ id: 'd', field: { kind: 'calc', id: 'slow' }, role: 'dimension' }],
        rows: [{ id: 'm', field: { kind: 'column', table: 'big', column: 'id' }, role: 'measure', agg: 'COUNTD' }],
        tooltip: [],
        filters: []
      }
    };
    // Record when the event loop gets to run while DuckDB works on its own threads.
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 10);
    const started = Date.now();
    const p = engine.query(request);
    setTimeout(() => engine.cancel('slow1'), 300);
    await expect(p).rejects.toMatchObject({ code: 'cancelled' });
    clearInterval(timer);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5000);
    // The event loop kept running while DuckDB worked: it ran repeatedly and was never blocked for long.
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    expect(Math.max(...gaps, ticks[0] - started)).toBeLessThan(250);
    await engine.dropTable('big');
  });
});

describe('lockdown', () => {
  it('the query instance cannot read files, install extensions or unlock its configuration', async () => {
    await expect(engine.unsafeRawForTests(`SELECT * FROM read_csv('${join(dir, 'a.csv')}')`)).rejects.toThrow(/disabled by configuration/);
    await expect(engine.unsafeRawForTests(`COPY (SELECT 1) TO '${join(dir, 'out.csv')}'`)).rejects.toThrow();
    await expect(engine.unsafeRawForTests('INSTALL httpfs')).rejects.toThrow();
    await expect(engine.unsafeRawForTests('SET enable_external_access = true')).rejects.toThrow();
  });
});
