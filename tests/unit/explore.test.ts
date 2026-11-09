import { beforeAll, describe, expect, it } from 'vitest';
import { compileViz } from '@shared/compiler/compile';
import { assemble, loadBase, loadWindow, nodeId, pickLevel, visibleEdges, type Base, type GNode, type GraphData, type Runner } from '@shared/explore/graph';
import { explainNode, findInsights, type Labels } from '@shared/explore/insights';
import type { Exploration, QueryResult, Scalar } from '@shared/types';
import { TestDb } from './helpers/db';

// Synthetic sales for 2024 with planted patterns:
// - East buys Furniture far more than its size suggests, and almost no Tech.
// - Customer c7 is huge (an outlier) and always South / Office.
// - West triples from October.
// - North spikes for one week in June.
const REGIONS = ['East', 'West', 'North', 'South'];
const CATS = ['Furniture', 'Tech', 'Office'];

function rows(): Scalar[][] {
  const out: Scalar[][] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let d = 0; d < 366; d++) {
    const day = new Date(start + d * 86_400_000).toISOString().slice(0, 10);
    const month = Number(day.slice(5, 7));
    REGIONS.forEach((r, ri) =>
      CATS.forEach((c, ci) => {
        let amount = 10;
        if (r === 'East' && c === 'Furniture') amount = 40;
        if (r === 'East' && c === 'Tech') amount = 1;
        if (r === 'West' && month >= 10) amount *= 3;
        if (r === 'North' && day >= '2024-06-10' && day <= '2024-06-16') amount *= 12;
        out.push([r, c, `c${(d + ri * 3 + ci) % 20}`, day, amount, r === 'East' || r === 'North' ? 'Z1' : 'Z2']);
      })
    );
    out.push(['South', 'Office', 'c7', day, 60, 'Z2']);
  }
  return out;
}

let db: TestDb;
let run: Runner;
const e: Exploration = {
  id: 'x',
  name: 'Sales',
  fields: [
    { kind: 'column', table: 's', column: 'region' },
    { kind: 'column', table: 's', column: 'category' },
    { kind: 'column', table: 's', column: 'customer' }
  ],
  measure: { field: { kind: 'column', table: 's', column: 'amount' }, agg: 'SUM' },
  time: { kind: 'column', table: 's', column: 'day' },
  topN: 30,
  links: 'both',
  colorBy: 'field'
};
const L: Labels = { node: (n) => String(n.value), field: (i) => ['region', 'category', 'customer'][i], amount: (v) => String(Math.round(v)), period: (p) => p };

beforeAll(async () => {
  db = await TestDb.create();
  await db.table(
    's',
    'sales',
    [
      ['region', 'VARCHAR'],
      ['category', 'VARCHAR'],
      ['customer', 'VARCHAR'],
      ['day', 'DATE'],
      ['amount', 'DOUBLE'],
      ['zone', 'VARCHAR']
    ],
    rows()
  );
  // Runs a spec exactly as the main process would, including the row limit.
  run = async (spec, maxRows) => {
    const q = compileViz(spec, db.model, { maxRows });
    const objs = await db.run(q);
    const result: QueryResult = {
      columns: q.columns,
      rows: objs.slice(0, maxRows).map((o) => q.columns.map((c) => o[c.key])),
      truncated: objs.length > maxRows,
      limit: maxRows,
      warnings: q.warnings,
      elapsedMs: 0
    };
    return result;
  };
});

describe('Explore graph', () => {
  let base: Base;
  let all: GraphData;

  beforeAll(async () => {
    base = await loadBase(e, run);
    all = await loadWindow(e, base, run, { from: 0, to: base.periods.length - 1 });
  });

  it('picks a period length from the date range', () => {
    expect(pickLevel('2024-01-01', '2024-02-15')).toBe('day');
    expect(pickLevel('2024-01-01', '2024-12-31')).toBe('week');
    expect(pickLevel('2020-01-01', '2024-12-31')).toBe('month');
    expect(base.level).toBe('week');
    expect(base.periods.length).toBeGreaterThanOrEqual(52);
  });

  it('builds nodes for the top values of each field, with series that add up', () => {
    expect(all.nodes.filter((n) => n.field === 0).map((n) => n.value)).toHaveLength(4);
    expect(all.nodes.filter((n) => n.field === 2)).toHaveLength(20);
    const east = all.nodes.find((n) => n.id === nodeId(0, 'East')) as GNode;
    expect(east.series.reduce((a, b) => a + b, 0)).toBeCloseTo(east.m, 6);
    expect(all.overall.reduce((a, b) => a + b, 0)).toBeCloseTo(all.total, 6);
  });

  it('computes lift: how much more often a pair occurs than if unrelated', () => {
    const edge = (a: string, b: string): number => all.edges.find((x) => x.a === nodeId(0, a) && x.b === nodeId(1, b))?.lift ?? NaN;
    expect(edge('East', 'Furniture')).toBeGreaterThan(1.5);
    expect(edge('East', 'Tech')).toBeLessThan(0.2);
    // East avoids Tech, so Tech's sales sit in the other regions: West is over-represented in it.
    expect(edge('West', 'Tech')).toBeGreaterThan(1);
    expect(edge('West', 'Tech')).toBeLessThan(edge('East', 'Furniture'));
  });

  it('finds the planted hidden link, avoided pair and outlier, and explains them', () => {
    const found = findInsights(all, L);
    const hidden = found.find((i) => i.kind === 'hiddenLink' && i.nodes.includes(nodeId(0, 'East')) && i.nodes.includes(nodeId(1, 'Furniture')));
    expect(hidden?.title).toMatch(/^East and Furniture go together [\d.]+× more than expected$/);
    expect(hidden?.detail).toMatch(/would be about [\d.]+% if unrelated/);
    expect(found.some((i) => i.kind === 'avoidedPair' && i.nodes.includes(nodeId(0, 'East')) && i.nodes.includes(nodeId(1, 'Tech')))).toBe(true);
    expect(found.some((i) => i.kind === 'outlier' && i.nodes[0] === nodeId(2, 'c7'))).toBe(true);
    // Ranked: most important first.
    expect(found.map((i) => i.score)).toEqual([...found.map((i) => i.score)].sort((a, b) => b - a));
  });

  it('finds the spike in its week', () => {
    const spike = findInsights(all, L).find((i) => i.kind === 'spike' && i.nodes[0] === nodeId(0, 'North'));
    expect(spike?.title).toMatch(/^North spiked in 2024-06-1\d$/);
  });

  it('compares a window with the one before it: movers and change', async () => {
    const lastQuarter = { from: base.periods.findIndex((p) => p >= '2024-10-01'), to: base.periods.length - 1 };
    const q4 = await loadWindow(e, base, run, lastQuarter);
    expect(q4.prevWindow).not.toBeNull();
    const west = q4.nodes.find((n) => n.id === nodeId(0, 'West')) as GNode;
    expect(west.m / (west.mPrev ?? 1)).toBeGreaterThan(2.5);
    const movers = findInsights(q4, L).filter((i) => i.kind === 'mover');
    expect(movers[0]?.nodes[0]).toBe(nodeId(0, 'West'));
    expect(movers[0]?.title).toMatch(/^West grew \d+%$/);
  });

  it('explains what makes a value different', () => {
    const east = explainNode(all, nodeId(0, 'East'));
    const cats = east.find((g) => g.field === 1);
    expect(cats?.over[0]?.node.value).toBe('Furniture');
    expect(cats?.under.map((d) => d.node.value)).toContain('Tech');
  });

  it('draws a limited number of links per value', () => {
    const shown = visibleEdges(all, 'both', 4);
    const count = new Map<string, number>();
    for (const x of shown) for (const n of [x.a, x.b]) count.set(n, (count.get(n) ?? 0) + 1);
    expect(shown.length).toBeLessThan(all.edges.length);
    // Each node keeps at most 4 of its own picks; it can also appear in links its neighbours picked.
    expect(Math.max(...count.values())).toBeLessThanOrEqual(all.nodes.length);
    expect(shown.some((x) => x.a === nodeId(0, 'East') && x.b === nodeId(1, 'Furniture'))).toBe(true);
  });

  it('recognises a hierarchy (each region in one zone) as structure, not as a hidden link', async () => {
    const withZone: Exploration = { ...e, fields: [...e.fields, { kind: 'column', table: 's', column: 'zone' }] };
    const b = await loadBase(withZone, run);
    const g = await loadWindow(withZone, b, run, { from: 0, to: b.periods.length - 1 });
    const labels: Labels = { ...L, field: (i) => ['region', 'category', 'customer', 'zone'][i] };
    const found = findInsights(g, labels);
    expect(found.some((i) => i.kind === 'structure' && i.title === 'Each region belongs to one zone')).toBe(true);
    const zoneLinks = found.filter(
      (i) => (i.kind === 'hiddenLink' || i.kind === 'avoidedPair') && i.nodes.some((n) => n.startsWith('3:')) && i.nodes.some((n) => n.startsWith('0:'))
    );
    expect(zoneLinks).toEqual([]);
    // Real surprises across other fields are still found.
    expect(found.some((i) => i.kind === 'hiddenLink' && i.nodes.includes(nodeId(0, 'East')) && i.nodes.includes(nodeId(1, 'Furniture')))).toBe(true);
  });

  it('works without a timeline', async () => {
    const flat: Exploration = { ...e, time: undefined };
    const b = await loadBase(flat, run);
    const g = await loadWindow(flat, b, run, null);
    expect(g.periods).toEqual([]);
    expect(g.total).toBeCloseTo(all.total, 6);
    expect(findInsights(g, L).some((i) => i.kind === 'hiddenLink')).toBe(true);
    expect(findInsights(g, L).some((i) => i.kind === 'mover' || i.kind === 'spike')).toBe(false);
  });
});

describe('insight scoring on a hand-built graph', () => {
  it('reports a pair that never occurs between two large values', () => {
    const node = (field: number, value: string, m: number): GNode => ({ id: nodeId(field, value), field, value, m, series: [] });
    const g = assemble(
      { ...e, fields: e.fields.slice(0, 2) },
      {
        values: [
          ['A', 'B'],
          ['X', 'Y']
        ],
        allTime: [
          new Map([
            [nodeId(0, 'A'), 50],
            [nodeId(0, 'B'), 50]
          ]),
          new Map([
            [nodeId(1, 'X'), 60],
            [nodeId(1, 'Y'), 40]
          ])
        ],
        series: [new Map(), new Map()],
        periods: [],
        overall: [],
        pairs: [
          {
            columns: [
              { key: 'f0', alias: 'a', role: 'dimension', type: 'string', label: '' },
              { key: 'f1', alias: 'b', role: 'dimension', type: 'string', label: '' },
              { key: 'm', alias: 'c', role: 'measure', type: 'number', label: '' }
            ],
            rows: [
              ['A', 'X', 50],
              ['B', 'Y', 40],
              ['B', 'X', 10]
            ],
            truncated: false,
            limit: 10,
            warnings: [],
            elapsedMs: 0
          }
        ],
        window: null,
        grandTotal: 100
      }
    );
    void node;
    expect(g.edges.map((x) => [x.id, x.lift])).toEqual([
      [`${nodeId(0, 'A')}|${nodeId(1, 'X')}`, 100 / 60],
      [`${nodeId(0, 'B')}|${nodeId(1, 'Y')}`, 2],
      [`${nodeId(0, 'B')}|${nodeId(1, 'X')}`, 1 / 3]
    ]);
    const never = findInsights(g, L).filter((i) => i.kind === 'avoidedPair' && i.title.endsWith('never go together'));
    // A and Y are both large (50% and 40% of the total) but never occur together. The data is mixed enough not to be a hierarchy.
    expect(never.map((i) => i.title)).toEqual(['A and Y never go together']);
  });
});
