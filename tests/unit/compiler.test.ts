import { beforeAll, describe, expect, it } from 'vitest';
import { CompileError, compileViz } from '@shared/compiler/compile';
import type { AggFn, DateLevel, FieldRef, ShelfItem } from '@shared/types';
import { TestDb } from './helpers/db';

// A small dataset whose results are easy to calculate by hand.
//
// orders                                              customers
// id cust region order_date  sales qty                cust name segment
//  1 c1   East   2024-01-15   100   1                  c1  Ann  Consumer
//  2 c1   East   2024-02-10   200   2                  c2  Bob  Corporate
//  3 c2   West   2024-01-20    50   1                  c3  Cid  Consumer
//  4 c3   West   2024-03-05   150   3                  c4  Dee  Corporate
//  5 c3   East   2024-03-25   300   1                  c5  Eve  Home (no orders)
//  6 c4   North  2024-02-28     0   0
//
// targets (two rows for East, so orders-targets on region is many-to-many)
// region target: East 1000, East 500, West 300

let db: TestDb;
let n = 0;
const col = (table: string, column: string): FieldRef => ({ kind: 'column', table, column });
const dim = (table: string, column: string, dateLevel?: DateLevel): ShelfItem => ({
  id: `i${n++}`,
  field: col(table, column),
  role: 'dimension',
  dateLevel
});
const meas = (table: string, column: string, agg: AggFn = 'SUM'): ShelfItem => ({ id: `i${n++}`, field: col(table, column), role: 'measure', agg });
const calcItem = (id: string, role: 'dimension' | 'measure' = 'measure', agg?: AggFn): ShelfItem => ({
  id: `i${n++}`,
  field: { kind: 'calc', id },
  role,
  agg
});
function addCalc(id: string, formula: string): void {
  db.model.calcs = db.model.calcs.filter((c) => c.id !== id);
  db.model.calcs.push({ id, name: id, formula });
}
function byKey<T extends Record<string, unknown>>(rows: T[], key: string): Record<string, T> {
  return Object.fromEntries(rows.map((r) => [String(r[key]), r]));
}

beforeAll(async () => {
  db = await TestDb.create();
  await db.table(
    'orders',
    'Orders',
    [
      ['id', 'INTEGER'],
      ['cust', 'VARCHAR'],
      ['region', 'VARCHAR'],
      ['order_date', 'DATE'],
      ['sales', 'DOUBLE'],
      ['qty', 'INTEGER'],
      ['date_text', 'VARCHAR']
    ],
    [
      [1, 'c1', 'East', '2024-01-15', 100, 1, '2024-01-15'],
      [2, 'c1', 'East', '2024-02-10', 200, 2, '2024-02-10'],
      [3, 'c2', 'West', '2024-01-20', 50, 1, '2024-01-20'],
      [4, 'c3', 'West', '2024-03-05', 150, 3, '2024-03-05'],
      [5, 'c3', 'East', '2024-03-25', 300, 1, '2024-03-25'],
      [6, 'c4', 'North', '2024-02-28', 0, 0, 'not a date']
    ]
  );
  await db.table(
    'customers',
    'Customers',
    [
      ['cust_id', 'VARCHAR'],
      ['name', 'VARCHAR'],
      ['segment', 'VARCHAR']
    ],
    [
      ['c1', 'Ann', 'Consumer'],
      ['c2', 'Bob', 'Corporate'],
      ['c3', 'Cid', 'Consumer'],
      ['c4', 'Dee', 'Corporate'],
      ['c5', 'Eve', 'Home']
    ]
  );
  await db.table(
    'targets',
    'Targets',
    [
      ['target_region', 'VARCHAR'],
      ['target', 'DOUBLE']
    ],
    [
      ['East', 1000],
      ['East', 500],
      ['West', 300]
    ]
  );
  db.model.relationships.push({
    id: 'r1',
    fromTable: 'orders',
    fromColumn: 'cust',
    toTable: 'customers',
    toColumn: 'cust_id',
    cardinality: 'many-to-one'
  });
});

describe('basic aggregation', () => {
  it('sums sales by region', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const { rows, q } = await db.viz({ columns: [r], rows: [s] });
    expect(rows).toEqual([
      { [r.id]: 'East', [s.id]: 600 },
      { [r.id]: 'North', [s.id]: 0 },
      { [r.id]: 'West', [s.id]: 200 }
    ]);
    expect(q.warnings).toEqual([]);
  });

  it('binds every value as a parameter and quotes identifiers', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const q = compileViz(
      {
        chartType: 'bar',
        columns: [r],
        rows: [s],
        tooltip: [],
        filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: ["East'; DROP TABLE x; --"] }]
      },
      db.model
    );
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.params).toContain("East'; DROP TABLE x; --");
    expect(q.sql).toContain('"region"');
    expect((await db.run(q)).length).toBe(0);
  });

  it('supports COUNT, COUNTD, AVG, MIN, MAX and MEDIAN', async () => {
    const items = (['COUNT', 'COUNTD', 'AVG', 'MIN', 'MAX', 'MEDIAN'] as AggFn[]).map((a) => meas('orders', a === 'COUNTD' ? 'cust' : 'sales', a));
    const { rows } = await db.viz({ rows: items });
    expect(rows[0]).toEqual({
      [items[0].id]: 6,
      [items[1].id]: 4,
      [items[2].id]: 800 / 6,
      [items[3].id]: 0,
      [items[4].id]: 300,
      [items[5].id]: 125
    });
  });

  it('truncates dates to the chosen level', async () => {
    const m = dim('orders', 'order_date', 'month');
    const s = meas('orders', 'sales');
    const { rows, q } = await db.viz({ columns: [m], rows: [s] });
    expect(rows).toEqual([
      { [m.id]: '2024-01-01', [s.id]: 150 },
      { [m.id]: '2024-02-01', [s.id]: 200 },
      { [m.id]: '2024-03-01', [s.id]: 450 }
    ]);
    expect(q.columns[0].type).toBe('date');
    const y = dim('orders', 'order_date', 'quarter');
    expect((await db.viz({ columns: [y], rows: [s] })).rows).toEqual([{ [y.id]: '2024-01-01', [s.id]: 800 }]);
  });

  it('sorts by a measure and truncates past the row limit with a flag', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const { rows, q } = await db.viz({ columns: [r], rows: [s], sort: { itemId: s.id, dir: 'desc' } }, { maxRows: 2 });
    // The query asks for maxRows + 1 rows so the engine can tell the result was truncated.
    expect(rows.map((x) => x[r.id])).toEqual(['East', 'West', 'North']);
    expect(q.maxRows).toBe(2);
  });
});

describe('joins', () => {
  it('joins a many-to-one dimension table without warnings', async () => {
    const seg = dim('customers', 'segment');
    const s = meas('orders', 'sales');
    const { rows, q } = await db.viz({ columns: [seg], rows: [s] });
    // Consumer = c1 + c3 = 100 + 200 + 150 + 300; Corporate = c2 + c4 = 50 + 0. Eve has no orders.
    expect(rows).toEqual([
      { [seg.id]: 'Consumer', [s.id]: 750 },
      { [seg.id]: 'Corporate', [s.id]: 50 }
    ]);
    expect(q.warnings).toEqual([]);
    expect(q.sql).not.toContain('t_targets');
  });

  it('only includes tables the query needs', () => {
    const q = compileViz({ chartType: 'bar', columns: [dim('orders', 'region')], rows: [meas('orders', 'sales')], tooltip: [], filters: [] }, db.model);
    expect(q.sql).not.toContain('t_customers');
  });

  it('warns that a many-to-many join multiplies rows, and the numbers show it', async () => {
    db.model.relationships.push({
      id: 'r2',
      fromTable: 'orders',
      fromColumn: 'region',
      toTable: 'targets',
      toColumn: 'target_region',
      cardinality: 'many-to-many'
    });
    try {
      const r = dim('orders', 'region');
      const s = meas('orders', 'sales');
      const t = meas('targets', 'target');
      const { rows, q } = await db.viz({ columns: [r], rows: [s, t] });
      expect(q.warnings).toHaveLength(1);
      expect(q.warnings[0]).toMatch(/many-to-many/);
      expect(q.warnings[0]).toMatch(/multiply rows/);
      const by = byKey(rows, r.id);
      // East has 3 orders and 2 target rows: each order appears twice, so 600 becomes 1200.
      expect(by['East'][s.id]).toBe(1200);
      // Each of the 2 East targets is repeated for 3 orders: (1000 + 500) * 3.
      expect(by['East'][t.id]).toBe(4500);
      expect(by['West'][s.id]).toBe(200);
      expect(by['North'][t.id]).toBeNull();
    } finally {
      db.model.relationships = db.model.relationships.filter((x) => x.id !== 'r2');
    }
  });

  it('warns when joining from the one side to the many side', () => {
    // Customers is the largest table only if we make it so: query just customer fields plus an order field.
    const q = compileViz(
      { chartType: 'bar', columns: [dim('customers', 'segment')], rows: [meas('orders', 'sales')], tooltip: [], filters: [] },
      { ...db.model, tables: db.model.tables.map((t) => (t.id === 'customers' ? { ...t, rowCount: 1000 } : t)) }
    );
    expect(q.warnings.some((w) => /counted more than once/.test(w))).toBe(true);
  });

  it('errors clearly when tables are not related', () => {
    expect(() =>
      compileViz({ chartType: 'bar', columns: [dim('targets', 'target_region')], rows: [meas('orders', 'sales')], tooltip: [], filters: [] }, db.model)
    ).toThrow(/not related/);
  });
});

describe('filters and pipeline order', () => {
  it('applies data source filters first', async () => {
    const t = db.model.tables.find((x) => x.id === 'orders')!;
    t.filters = [{ id: 'ds', kind: 'range', field: col('orders', 'sales'), min: 1 }];
    try {
      const r = dim('orders', 'region');
      const { rows } = await db.viz({ columns: [r], rows: [meas('orders', 'sales')] });
      expect(rows.map((x) => x[r.id])).toEqual(['East', 'West']);
    } finally {
      delete t.filters;
    }
  });

  it('applies dimension filters (include and exclude, with nulls)', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const inc = await db.viz({ columns: [r], rows: [s], filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: ['East', 'West'] }] });
    expect(inc.rows.map((x) => x[r.id])).toEqual(['East', 'West']);
    const exc = await db.viz({
      columns: [r],
      rows: [s],
      filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: ['East'], exclude: true }]
    });
    expect(exc.rows.map((x) => x[r.id])).toEqual(['North', 'West']);
    const none = await db.viz({ columns: [r], rows: [s], filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: [] }] });
    expect(none.rows).toEqual([]);
  });

  it('applies date range filters', async () => {
    const s = meas('orders', 'sales');
    const { rows } = await db.viz({
      rows: [s],
      filters: [{ id: 'f', kind: 'range', field: col('orders', 'order_date'), min: '2024-02-01', max: '2024-02-29' }]
    });
    expect(rows[0][s.id]).toBe(200);
  });

  it('applies measure filters after aggregation (HAVING)', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const { rows } = await db.viz({
      columns: [r],
      rows: [s],
      filters: [{ id: 'f', kind: 'measure', field: col('orders', 'sales'), agg: 'SUM', op: '>', value: 100 }]
    });
    expect(rows.map((x) => x[r.id])).toEqual(['East', 'West']);
  });

  it('applies Top N filters', async () => {
    const c = dim('orders', 'cust');
    const s = meas('orders', 'sales');
    const { rows } = await db.viz({
      columns: [c],
      rows: [s],
      filters: [{ id: 'f', kind: 'topN', field: col('orders', 'cust'), n: 2, by: { field: col('orders', 'sales'), agg: 'SUM' }, direction: 'top' }]
    });
    // c3 = 450, c1 = 300.
    expect(rows).toEqual([
      { [c.id]: 'c1', [s.id]: 300 },
      { [c.id]: 'c3', [s.id]: 450 }
    ]);
  });

  it('ranks Top N before other dimension filters, then intersects them (Tableau order)', async () => {
    const c = dim('orders', 'cust');
    const s = meas('orders', 'sales');
    const top2 = {
      id: 'f',
      kind: 'topN' as const,
      field: col('orders', 'cust'),
      n: 2,
      by: { field: col('orders', 'sales'), agg: 'SUM' as const },
      direction: 'top' as const
    };
    const west = { id: 'w', kind: 'values' as const, field: col('orders', 'region'), values: ['West'] };
    // Overall top 2 is c3 (450) and c1 (300). Only c3 has West orders (150).
    const { rows } = await db.viz({ columns: [c], rows: [s], filters: [top2, west] });
    expect(rows).toEqual([{ [c.id]: 'c3', [s.id]: 150 }]);
    // As a context filter, West applies first: the top 2 within West are c3 (150) and c2 (50).
    const ctx = await db.viz({ columns: [c], rows: [s], filters: [top2, { ...west, context: true }] });
    expect(ctx.rows).toEqual([
      { [c.id]: 'c2', [s.id]: 50 },
      { [c.id]: 'c3', [s.id]: 150 }
    ]);
  });

  it('applies dashboard slicers before Top N ranking', async () => {
    const c = dim('orders', 'cust');
    const s = meas('orders', 'sales');
    const { rows } = await db.viz(
      {
        columns: [c],
        rows: [s],
        filters: [{ id: 'f', kind: 'topN', field: col('orders', 'cust'), n: 2, by: { field: col('orders', 'sales'), agg: 'SUM' }, direction: 'top' }]
      },
      { externalFilters: [{ id: 'x', kind: 'values', field: col('orders', 'region'), values: ['West'] }] }
    );
    expect(rows).toEqual([
      { [c.id]: 'c2', [s.id]: 50 },
      { [c.id]: 'c3', [s.id]: 150 }
    ]);
  });

  it('explains that aggregate conditions need a number', () => {
    const spec = {
      chartType: 'auto' as const,
      columns: [dim('orders', 'region')],
      rows: [meas('orders', 'sales')],
      tooltip: [],
      filters: [{ id: 'm', kind: 'measure' as const, field: col('orders', 'order_date'), agg: 'MAX' as const, op: '>=' as const, value: 1 }]
    };
    expect(() => compileViz(spec, db.model)).toThrow(/compare numbers, but Max of order_date is a date/);
  });

  it('binds exactly the values the SQL uses when LOD expressions repeat', async () => {
    addCalc('double_fixed', 'MAX({FIXED [region] : SUM([sales] * 2)}) + MAX({FIXED [region] : SUM([sales] * 2)})');
    const r = dim('orders', 'region');
    const m = calcItem('double_fixed');
    for (const noLimit of [false, true]) {
      const { rows, q } = await db.viz({ columns: [r], rows: [m] }, { noLimit });
      const used = new Set([...q.sql.matchAll(/CAST\(\$(\d+) AS /g)].map((x) => Number(x[1])));
      expect([...used].sort((a, b) => a - b)).toEqual(q.params.map((_, i) => i + 1));
      // East: 2 x (100 + 200 + 300) = 1200, counted twice.
      expect(byKey(rows, r.id)['East'][m.id]).toBe(2400);
      expect(byKey(rows, r.id)['West'][m.id]).toBe(800);
    }
  });

  it('applies slicers on a related table and skips unrelated ones with a warning', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const { rows, q } = await db.viz(
      { columns: [r], rows: [s] },
      {
        externalFilters: [
          { id: 'x', kind: 'values', field: col('customers', 'segment'), values: ['Consumer'] },
          { id: 'y', kind: 'values', field: col('targets', 'target_region'), values: ['East'] }
        ]
      }
    );
    // Consumer orders: East 100 + 200 + 300, West 150.
    expect(rows).toEqual([
      { [r.id]: 'East', [s.id]: 600 },
      { [r.id]: 'West', [s.id]: 150 }
    ]);
    expect(q.warnings.join(' ')).toMatch(/does not apply/);
  });

  it('applies cross-filters on a truncated date', async () => {
    const r = dim('orders', 'region');
    const s = meas('orders', 'sales');
    const { rows } = await db.viz(
      { columns: [r], rows: [s] },
      { externalFilters: [{ id: 'x', kind: 'values', field: col('orders', 'order_date'), dateLevel: 'month', values: ['2024-03-01'] }] }
    );
    expect(rows).toEqual([
      { [r.id]: 'East', [s.id]: 300 },
      { [r.id]: 'West', [s.id]: 150 }
    ]);
  });

  it('applies type overrides before everything else', async () => {
    const t = db.model.tables.find((x) => x.id === 'orders')!;
    const c = t.columns.find((x) => x.name === 'date_text')!;
    c.override = 'date';
    try {
      const m = dim('orders', 'date_text', 'month');
      const s = meas('orders', 'sales');
      const { rows } = await db.viz({ columns: [m], rows: [s] });
      // 'not a date' becomes null rather than failing the query.
      expect(rows).toEqual([
        { [m.id]: '2024-01-01', [s.id]: 150 },
        { [m.id]: '2024-02-01', [s.id]: 200 },
        { [m.id]: '2024-03-01', [s.id]: 450 },
        { [m.id]: null, [s.id]: 0 }
      ]);
    } finally {
      delete c.override;
    }
  });
});

describe('level of detail expressions', () => {
  it('FIXED computes at its own dimensions and joins back to rows', async () => {
    addCalc('cust_total', '{FIXED [cust] : SUM([sales])}');
    const r = dim('orders', 'region');
    const avg = calcItem('cust_total', 'measure', 'AVG');
    const { rows } = await db.viz({ columns: [r], rows: [avg] });
    // Customer totals: c1 300, c2 50, c3 450, c4 0. East rows: 300, 300, 450. West rows: 50, 450.
    expect(byKey(rows, r.id)['East'][avg.id]).toBe(350);
    expect(byKey(rows, r.id)['West'][avg.id]).toBe(250);
    expect(byKey(rows, r.id)['North'][avg.id]).toBe(0);
  });

  it('FIXED ignores dimension filters but respects context filters', async () => {
    addCalc('cust_total', '{FIXED [cust] : SUM([sales])}');
    const c = dim('orders', 'cust');
    const fx = calcItem('cust_total', 'measure', 'MAX');
    const s = meas('orders', 'sales');
    const filter = { id: 'f', kind: 'values' as const, field: col('orders', 'region'), values: ['East'] };
    const dimFiltered = await db.viz({ columns: [c], rows: [s, fx], filters: [filter] });
    // c3 has 300 in the East but 450 overall; FIXED runs before the dimension filter.
    expect(byKey(dimFiltered.rows, c.id)['c3']).toEqual({ [c.id]: 'c3', [s.id]: 300, [fx.id]: 450 });
    const ctxFiltered = await db.viz({ columns: [c], rows: [s, fx], filters: [{ ...filter, context: true }] });
    expect(byKey(ctxFiltered.rows, c.id)['c3']).toEqual({ [c.id]: 'c3', [s.id]: 300, [fx.id]: 300 });
  });

  it('FIXED with no dimensions gives the grand total, and can be used as a dimension', async () => {
    addCalc('share', 'SUM([sales]) / MIN({FIXED : SUM([sales])})');
    addCalc('big_customer', 'IF {FIXED [cust] : SUM([sales])} >= 300 THEN "Big" ELSE "Small" END');
    const r = dim('orders', 'region');
    const share = calcItem('share');
    const big = calcItem('big_customer', 'dimension');
    const s = meas('orders', 'sales');
    const a = await db.viz({ columns: [r], rows: [share] });
    expect(byKey(a.rows, r.id)['East'][share.id]).toBe(0.75);
    const b = await db.viz({ columns: [big], rows: [s] });
    // Big customers c1 (300) and c3 (450): 100 + 200 + 150 + 300 = 750.
    expect(b.rows).toEqual([
      { [big.id]: 'Big', [s.id]: 750 },
      { [big.id]: 'Small', [s.id]: 50 }
    ]);
  });

  it('nested FIXED expressions work', async () => {
    // Average customer total per region, fixed per region: East (300 + 450) / 2 (distinct customers c1, c3 by row avg).
    addCalc('nested', '{FIXED [region] : MAX({FIXED [cust] : SUM([sales])})}');
    const r = dim('orders', 'region');
    const m = calcItem('nested', 'measure', 'MIN');
    const { rows } = await db.viz({ columns: [r], rows: [m] });
    expect(byKey(rows, r.id)['East'][m.id]).toBe(450);
    expect(byKey(rows, r.id)['West'][m.id]).toBe(450);
    expect(byKey(rows, r.id)['North'][m.id]).toBe(0);
  });

  it('INCLUDE aggregates at a finer level, then to the view', async () => {
    addCalc('avg_cust', 'AVG({INCLUDE [cust] : SUM([sales])})');
    const r = dim('orders', 'region');
    const m = calcItem('avg_cust');
    const s = meas('orders', 'sales');
    const { rows } = await db.viz({ columns: [r], rows: [m, s] });
    // East: c1 300, c3 300 -> 300. West: c2 50, c3 150 -> 100. North: c4 0.
    expect(rows).toEqual([
      { [r.id]: 'East', [m.id]: 300, [s.id]: 600 },
      { [r.id]: 'North', [m.id]: 0, [s.id]: 0 },
      { [r.id]: 'West', [m.id]: 100, [s.id]: 200 }
    ]);
  });

  it('INCLUDE respects dimension filters', async () => {
    addCalc('avg_cust', 'AVG({INCLUDE [cust] : SUM([sales])})');
    const m = calcItem('avg_cust');
    const { rows } = await db.viz({
      rows: [m],
      filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: ['West'] }]
    });
    // West only: c2 50, c3 150.
    expect(rows[0][m.id]).toBe(100);
  });

  it('INCLUDE placed bare on a shelf uses the shelf aggregation', async () => {
    addCalc('inc_bare', '{INCLUDE [cust] : SUM([sales])}');
    const m = calcItem('inc_bare', 'measure', 'MAX');
    const { rows } = await db.viz({ rows: [m] });
    // Largest customer total overall: c3 = 450.
    expect(rows[0][m.id]).toBe(450);
  });

  it('EXCLUDE aggregates at a coarser level and repeats it for each mark', async () => {
    addCalc('region_total', 'SUM({EXCLUDE [cust] : SUM([sales])})');
    addCalc('pct_of_region', 'SUM([sales]) / [region_total]');
    const r = dim('orders', 'region');
    const c = dim('orders', 'cust');
    const t = calcItem('region_total');
    const p = calcItem('pct_of_region');
    const { rows } = await db.viz({ columns: [r, c], rows: [t, p] });
    const key = (x: Record<string, unknown>) => `${x[r.id]}/${x[c.id]}`;
    const by = Object.fromEntries(rows.map((x) => [key(x), x]));
    expect(by['East/c1'][t.id]).toBe(600);
    expect(by['East/c3'][t.id]).toBe(600);
    expect(by['West/c2'][t.id]).toBe(200);
    expect(by['East/c1'][p.id]).toBe(0.5);
    expect(by['West/c3'][p.id]).toBe(0.75);
    // North total is 0, so safe division gives null instead of an error.
    expect(by['North/c4'][p.id]).toBeNull();
  });

  it('EXCLUDE of a date dimension matches whatever date level the view uses', async () => {
    addCalc('all_months', 'MAX({EXCLUDE [order_date] : SUM([sales])})');
    const m = dim('orders', 'order_date', 'month');
    const x = calcItem('all_months');
    const { rows } = await db.viz({ columns: [m], rows: [x] });
    expect(rows.map((r) => r[x.id])).toEqual([800, 800, 800]);
  });
});

describe('table calculations', () => {
  it('computes running sum, percent of total, rank and lag along the first dimension', async () => {
    addCalc('run', 'RUNNING_SUM(SUM([sales]))');
    addCalc('pct', 'PERCENT_OF_TOTAL(SUM([sales]))');
    addCalc('rnk', 'RANK(SUM([sales]))');
    addCalc('prev', 'LAG(SUM([sales]), 1)');
    addCalc('diff', 'SUM([sales]) - LAG(SUM([sales]))');
    const m = dim('orders', 'order_date', 'month');
    const items = ['run', 'pct', 'rnk', 'prev', 'diff'].map((id) => calcItem(id));
    const { rows } = await db.viz({ columns: [m], rows: items });
    // Months: Jan 150, Feb 200, Mar 450.
    expect(rows.map((r) => r[items[0].id])).toEqual([150, 350, 800]);
    expect(rows.map((r) => r[items[1].id])).toEqual([150 / 800, 200 / 800, 450 / 800]);
    expect(rows.map((r) => r[items[2].id])).toEqual([3, 2, 1]);
    expect(rows.map((r) => r[items[3].id])).toEqual([null, 150, 200]);
    expect(rows.map((r) => r[items[4].id])).toEqual([null, 50, 250]);
  });

  it('restarts table calculations for each value of the other dimensions', async () => {
    addCalc('run', 'RUNNING_SUM(SUM([sales]))');
    const m = dim('orders', 'order_date', 'month');
    const r = dim('orders', 'region');
    const run = calcItem('run');
    const { rows } = await db.viz({
      columns: [m],
      rows: [run],
      color: r,
      filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: ['East'] }]
    });
    // East by month: Jan 100, Feb 200, Mar 300.
    expect(rows.map((x) => x[run.id])).toEqual([100, 300, 600]);
  });

  it('runs along the dimension chosen with calcAlong, and partitions by the others', async () => {
    addCalc('pct', 'PERCENT_OF_TOTAL(SUM([sales]))');
    const m = dim('orders', 'order_date', 'month');
    const r = dim('orders', 'region');
    const pct = calcItem('pct');
    const sums = (rows: Record<string, unknown>[], by: string): number[] => {
      const totals = new Map<string, number>();
      // A region with no sales has a null share and is left out.
      for (const row of rows) if (row[pct.id] !== null) totals.set(String(row[by]), (totals.get(String(row[by])) ?? 0) + Number(row[pct.id]));
      return [...totals.values()].map((v) => Math.round(v * 1e9) / 1e9);
    };
    // Default: along the month on Columns, so each region's shares add up to 1.
    const along = await db.viz({ columns: [m], rows: [pct], color: r });
    expect(sums(along.rows, r.id).every((v) => v === 1)).toBe(true);
    // Along region instead: each month's shares add up to 1.
    const across = await db.viz({ columns: [m], rows: [pct], color: r, calcAlong: r.id });
    expect(sums(across.rows, m.id).every((v) => v === 1)).toBe(true);
    expect(sums(across.rows, r.id).every((v) => v === 1)).toBe(false);
    // An id that is no longer in the view falls back to the default.
    const stale = await db.viz({ columns: [m], rows: [pct], color: r, calcAlong: 'gone' });
    expect(stale.rows).toEqual(along.rows);
  });
});

describe('formulas compiled to SQL', () => {
  const cases: [string, string, unknown][] = [
    ['if', 'IF SUM([sales]) > 500 THEN "high" ELSEIF SUM([sales]) > 100 THEN "mid" ELSE "low" END', 'mid'],
    ['case', 'CASE MIN([region]) WHEN "West" THEN 1 WHEN "East" THEN 2 ELSE 0 END', 1],
    ['div0', 'SUM([sales]) / SUM([qty]) ', 50],
    ['round', 'ROUND(AVG([sales]) / 3, 2)', 33.33],
    ['text', 'UPPER(LEFT(MIN([region]), 2)) + LOWER(RIGHT(MAX([cust]), 1))', 'WE3'],
    ['contains', 'IF CONTAINS(MIN([region]), "es") THEN "yes" ELSE "no" END', 'yes'],
    ['replace', 'REPLACE(MIN(TRIM("  " + [region] + " ")), "W", "V")', 'Vest'],
    ['dates', 'MIN(YEAR([order_date]) * 10000 + MONTH([order_date]) * 100 + DAY([order_date]))', 20240120],
    ['quarter', 'MAX(QUARTER([order_date]))', 1],
    // 20 Jan to 5 Mar 2024 is 45 days (2024 is a leap year).
    ['datediff', 'DATEDIFF("day", MIN([order_date]), MAX([order_date]))', 45],
    ['dateadd', 'MAX(DATEADD("month", 1, [order_date]))', '2024-04-05'],
    ['dateadd_q', 'MAX(DATEADD("quarter", -1, [order_date]))', '2023-12-05'],
    ['datetrunc', 'MIN(DATETRUNC("month", [order_date]))', '2024-01-01'],
    ['abs', 'ABS(MIN(-[sales]))', 150],
    ['floorceil', 'FLOOR(AVG([qty])) * 10 + CEIL(AVG([qty]))', 22],
    ['isnull', 'SUM(IF ISNULL([sales]) THEN 1 ELSE 0 END) + SUM(IFNULL([sales], 0)) / 1000', 0.2],
    ['logic', 'IF NOT (MIN([qty]) = 1 AND MAX([qty]) = 3) OR FALSE THEN 1 ELSE 0 END', 0],
    ['datelit', 'SUM(IF [order_date] >= #2024-03-01# THEN [sales] END)', 150]
  ];
  it.each(cases)('%s', async (id, formula, expected) => {
    addCalc(id, formula);
    const item = calcItem(id);
    const { rows } = await db.viz({
      rows: [item],
      filters: [{ id: 'f', kind: 'values', field: col('orders', 'region'), values: ['West'] }]
    });
    expect(rows[0][item.id]).toEqual(expected);
  });

  it('safe division returns null for zero', async () => {
    addCalc('ratio', 'SUM([sales]) / SUM([qty])');
    const r = dim('orders', 'region');
    const item = calcItem('ratio');
    const { rows } = await db.viz({ columns: [r], rows: [item] });
    expect(byKey(rows, r.id)['East'][item.id]).toBe(150);
    expect(byKey(rows, r.id)['North'][item.id]).toBeNull();
  });

  it('row-level calculated columns work as dimensions and as measures', async () => {
    addCalc('size', 'IF [qty] >= 2 THEN "multi" ELSE "single" END');
    addCalc('net', '[sales] * 0.5');
    const d = calcItem('size', 'dimension');
    const m = calcItem('net', 'measure', 'SUM');
    const { rows } = await db.viz({ columns: [d], rows: [m] });
    expect(rows).toEqual([
      { [d.id]: 'multi', [m.id]: 175 },
      { [d.id]: 'single', [m.id]: 225 }
    ]);
  });

  it('TODAY returns the current date', async () => {
    addCalc('today', 'MAX(TODAY())');
    const item = calcItem('today');
    const { rows } = await db.viz({ rows: [item, meas('orders', 'sales')] });
    // The local date, not the UTC one (they differ for part of the day outside UTC). en-CA formats as YYYY-MM-DD.
    expect(rows[0][item.id]).toBe(new Date().toLocaleDateString('en-CA'));
  });
});

describe('compile errors', () => {
  it('rejects an aggregate used as a dimension', () => {
    addCalc('agg', 'SUM([sales])');
    const item = calcItem('agg', 'dimension');
    expect(() => compileViz({ chartType: 'bar', columns: [item], rows: [], tooltip: [], filters: [] }, db.model)).toThrow(CompileError);
  });

  it('rejects SUM over text', () => {
    expect(() => compileViz({ chartType: 'bar', columns: [], rows: [meas('orders', 'region', 'SUM')], tooltip: [], filters: [] }, db.model)).toThrow(
      /needs a number/
    );
  });

  it('rejects an empty view', () => {
    expect(() => compileViz({ chartType: 'bar', columns: [], rows: [], tooltip: [], filters: [] }, db.model)).toThrow(/Add a field/);
  });
});
