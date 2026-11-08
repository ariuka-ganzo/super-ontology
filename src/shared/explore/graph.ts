// Turns an Exploration into view queries, and their results into a relationship graph.
// See docs/EXPLORE.md. Everything here is pure: the renderer runs the queries through the
// normal query API (so joins, filters and cleaning steps apply) and passes the results back in.
import type { DateLevel, Exploration, FieldRef, FilterDef, QueryResult, Scalar, ShelfItem, VizSpec } from '../types';

export const MAX_FIELDS = 6;

const fieldItem = (i: number): string => `f${i}`;
const MEASURE = 'm';
const TIME = 't';

function dim(id: string, field: FieldRef, dateLevel?: DateLevel): ShelfItem {
  return dateLevel ? { id, field, role: 'dimension', dateLevel } : { id, field, role: 'dimension' };
}

function measureItem(e: Exploration): ShelfItem {
  return { id: MEASURE, field: e.measure.field, role: 'measure', agg: e.measure.agg };
}

function spec(columns: ShelfItem[], rows: ShelfItem[], filters: FilterDef[] = [], sort?: VizSpec['sort']): VizSpec {
  return { chartType: 'table', columns, rows, tooltip: [], filters, ...(sort ? { sort } : {}) };
}

/** A window of whole periods, by index into `periods`, inclusive. */
export interface TimeWindow {
  from: number;
  to: number;
}

/** Picks a period length that gives a readable number of periods for a date range. */
export function pickLevel(min: string, max: string): DateLevel {
  const days = (Date.parse(max) - Date.parse(min)) / 86_400_000;
  if (!Number.isFinite(days) || days <= 62) return 'day';
  if (days <= 366) return 'week';
  if (days <= 366 * 6) return 'month';
  if (days <= 366 * 20) return 'quarter';
  return 'year';
}

function windowFilter(e: Exploration, level: DateLevel, periods: string[], w: TimeWindow): FilterDef[] {
  if (!e.time || !periods.length) return [];
  return [{ id: 'win', kind: 'range', field: e.time, dateLevel: level, min: periods[w.from], max: periods[w.to] }];
}

function valuesFilter(id: string, field: FieldRef, values: Scalar[]): FilterDef {
  return { id, kind: 'values', field, values };
}

/** The queries that do not depend on the time window. */
export const queries = {
  /** Earliest and latest date, to choose the period length. */
  timeRange(e: Exploration): VizSpec | null {
    if (!e.time) return null;
    return spec(
      [],
      [
        { id: 'lo', field: e.time, role: 'measure', agg: 'MIN' },
        { id: 'hi', field: e.time, role: 'measure', agg: 'MAX' }
      ]
    );
  },
  /** The measure per period over all time. */
  overall(e: Exploration, level: DateLevel): VizSpec {
    return e.time ? spec([dim(TIME, e.time, level)], [measureItem(e)]) : spec([], [measureItem(e)]);
  },
  /** The largest values of field `i` over all time. Request `topN` rows. */
  top(e: Exploration, i: number): VizSpec {
    return spec([dim(fieldItem(i), e.fields[i])], [measureItem(e)], [], { itemId: MEASURE, dir: 'desc' });
  },
  /** Each chosen value of field `i` per period. */
  series(e: Exploration, i: number, values: Scalar[], level: DateLevel): VizSpec {
    return spec([dim(fieldItem(i), e.fields[i]), dim(TIME, e.time as FieldRef, level)], [measureItem(e)], [valuesFilter('vals', e.fields[i], values)]);
  },
  /** The measure for each pair of chosen values of fields `i` and `j`, within a window. */
  pair(e: Exploration, i: number, j: number, vi: Scalar[], vj: Scalar[], level: DateLevel, periods: string[], w: TimeWindow): VizSpec {
    return spec(
      [dim(fieldItem(i), e.fields[i]), dim(fieldItem(j), e.fields[j])],
      [measureItem(e)],
      [valuesFilter('vi', e.fields[i], vi), valuesFilter('vj', e.fields[j], vj), ...windowFilter(e, level, periods, w)]
    );
  },
  /** Field `i`'s chosen values, within a window (used when there is no timeline). */
  values(e: Exploration, i: number, values: Scalar[]): VizSpec {
    return spec([dim(fieldItem(i), e.fields[i])], [measureItem(e)], [valuesFilter('vals', e.fields[i], values)]);
  }
};

/** Pairs of field indexes, each once. */
export function fieldPairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

function col(r: QueryResult, key: string): number {
  const i = r.columns.findIndex((c) => c.key === key);
  if (i < 0) throw new Error(`Column ${key} missing from result`);
  return i;
}

const num = (v: Scalar): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : 0;

export const nodeId = (field: number, value: Scalar): string => `${field}:${JSON.stringify(value)}`;

/** The chosen values of a field: the top rows of a `top` query, without nulls. */
export function topValues(r: QueryResult, i: number, topN: number): Scalar[] {
  const c = col(r, fieldItem(i));
  return r.rows
    .map((row) => row[c])
    .filter((v) => v !== null)
    .slice(0, topN);
}

/** Period labels in order, from the `overall` query, and the measure in each. */
export function periodsOf(r: QueryResult): { periods: string[]; values: number[] } {
  const t = r.columns.findIndex((c) => c.key === TIME);
  const m = col(r, MEASURE);
  if (t < 0) return { periods: [], values: [] };
  const rows = r.rows.filter((row) => row[t] !== null).sort((a, b) => String(a[t]).localeCompare(String(b[t])));
  return { periods: rows.map((row) => String(row[t])), values: rows.map((row) => num(row[m])) };
}

export interface GNode {
  id: string;
  /** Index into Exploration.fields. */
  field: number;
  value: Scalar;
  /** Measure in the current window. */
  m: number;
  /** Measure in the previous window of the same length, when there is a timeline. */
  mPrev?: number;
  /** Measure per period over all time, aligned with GraphData.periods. */
  series: number[];
}

export interface GEdge {
  id: string;
  a: string;
  b: string;
  m: number;
  mPrev?: number;
  /** How many times more often the pair occurs than if its two values were unrelated. */
  lift: number;
  liftPrev?: number;
  /** The pair's share of the window's total. */
  share: number;
}

export interface GraphData {
  nodes: GNode[];
  edges: GEdge[];
  /** Total of the measure in the window, over all values (not only the chosen ones). */
  total: number;
  totalPrev?: number;
  periods: string[];
  /** Total per period over all time. */
  overall: number[];
  window: TimeWindow | null;
  prevWindow: TimeWindow | null;
}

/** The window of the same length just before `w`, or null when it would start before the first period. */
export function previousWindow(w: TimeWindow): TimeWindow | null {
  const len = w.to - w.from + 1;
  return w.from - len >= 0 ? { from: w.from - len, to: w.from - 1 } : null;
}

const sumRange = (xs: number[], w: TimeWindow): number => xs.slice(w.from, w.to + 1).reduce((a, b) => a + b, 0);

/** Builds per-value series from `series` query results, aligned with `periods`. */
export function seriesOf(r: QueryResult, i: number, periods: string[]): Map<string, number[]> {
  const f = col(r, fieldItem(i));
  const t = col(r, TIME);
  const m = col(r, MEASURE);
  const at = new Map(periods.map((p, k) => [p, k]));
  const out = new Map<string, number[]>();
  for (const row of r.rows) {
    const k = at.get(String(row[t]));
    if (k === undefined || row[f] === null) continue;
    const id = nodeId(i, row[f]);
    let s = out.get(id);
    if (!s) out.set(id, (s = new Array<number>(periods.length).fill(0)));
    s[k] += num(row[m]);
  }
  return out;
}

export interface Assembly {
  values: Scalar[][];
  /** Per field: node id -> measure over all time (from the `top` query). */
  allTime: Map<string, number>[];
  series: Map<string, number[]>[];
  periods: string[];
  overall: number[];
  /** Pair results for the window, in fieldPairs order. */
  pairs: QueryResult[];
  pairsPrev?: QueryResult[];
  /** `values` query results when there is no timeline, per field. */
  valueTotals?: QueryResult[];
  window: TimeWindow | null;
  /** Total over all time when there is no timeline. */
  grandTotal?: number;
}

/** Assembles nodes and edges for a window from query results. */
export function assemble(e: Exploration, a: Assembly): GraphData {
  const w = a.window;
  const pw = w ? previousWindow(w) : null;
  const nodes: GNode[] = [];
  const byId = new Map<string, GNode>();
  a.values.forEach((vals, i) => {
    const valueTotals = a.valueTotals?.[i];
    const vt = new Map<string, number>();
    if (valueTotals) {
      const f = col(valueTotals, fieldItem(i));
      const m = col(valueTotals, MEASURE);
      for (const row of valueTotals.rows) vt.set(nodeId(i, row[f]), num(row[m]));
    }
    for (const v of vals) {
      const id = nodeId(i, v);
      const series = a.series[i]?.get(id) ?? new Array<number>(a.periods.length).fill(0);
      const node: GNode = {
        id,
        field: i,
        value: v,
        m: w ? sumRange(series, w) : (vt.get(id) ?? a.allTime[i]?.get(id) ?? 0),
        series,
        ...(pw ? { mPrev: sumRange(series, pw) } : {})
      };
      nodes.push(node);
      byId.set(id, node);
    }
  });
  const total = w ? sumRange(a.overall, w) : (a.grandTotal ?? 0);
  const totalPrev = pw ? sumRange(a.overall, pw) : undefined;

  const pairEdges = (results: QueryResult[] | undefined): Map<string, { a: string; b: string; m: number }> => {
    const out = new Map<string, { a: string; b: string; m: number }>();
    if (!results) return out;
    fieldPairs(e.fields.length).forEach(([i, j], k) => {
      const r = results[k];
      if (!r || !r.columns.length) return;
      const fi = col(r, fieldItem(i));
      const fj = col(r, fieldItem(j));
      const m = col(r, MEASURE);
      for (const row of r.rows) {
        if (row[fi] === null || row[fj] === null) continue;
        const ia = nodeId(i, row[fi]);
        const ib = nodeId(j, row[fj]);
        if (!byId.has(ia) || !byId.has(ib)) continue;
        const id = `${ia}|${ib}`;
        const prev = out.get(id);
        out.set(id, { a: ia, b: ib, m: (prev?.m ?? 0) + num(row[m]) });
      }
    });
    return out;
  };

  const lift = (m: number, ma: number, mb: number, t: number): number => (ma > 0 && mb > 0 && t > 0 ? (m * t) / (ma * mb) : 0);
  const now = pairEdges(a.pairs);
  const before = pairEdges(a.pairsPrev);
  const edges: GEdge[] = [];
  for (const [id, p] of now) {
    if (p.m <= 0) continue;
    const na = byId.get(p.a) as GNode;
    const nb = byId.get(p.b) as GNode;
    const prev = before.get(id);
    const edge: GEdge = { id, a: p.a, b: p.b, m: p.m, lift: lift(p.m, na.m, nb.m, total), share: total > 0 ? p.m / total : 0 };
    if (pw) {
      edge.mPrev = prev?.m ?? 0;
      if (prev && prev.m > 0 && totalPrev) edge.liftPrev = lift(prev.m, na.mPrev ?? 0, nb.mPrev ?? 0, totalPrev);
    }
    edges.push(edge);
  }
  return { nodes, edges, total, totalPrev, periods: a.periods, overall: a.overall, window: w, prevWindow: pw };
}

/** Runs a view query; the renderer passes the IPC query API, tests pass DuckDB directly. */
export type Runner = (spec: VizSpec, maxRows: number) => Promise<QueryResult>;

/** Everything that does not depend on the time window: the chosen values and their series. */
export interface Base {
  level: DateLevel | null;
  periods: string[];
  overall: number[];
  values: Scalar[][];
  allTime: Map<string, number>[];
  series: Map<string, number[]>[];
  valueTotals?: QueryResult[];
  grandTotal?: number;
}

const MAX_PERIODS = 400;

/** Loads the values, series and periods for an exploration. Queries run in parallel. */
export async function loadBase(e: Exploration, run: Runner): Promise<Base> {
  const tops = e.fields.map((_, i) => run(queries.top(e, i), e.topN + 1));
  let level: DateLevel | null = null;
  const rangeSpec = queries.timeRange(e);
  if (rangeSpec) {
    const r = await run(rangeSpec, 1);
    const lo = r.rows[0]?.[col(r, 'lo')];
    const hi = r.rows[0]?.[col(r, 'hi')];
    if (lo !== null && lo !== undefined && hi !== null && hi !== undefined) level = pickLevel(String(lo), String(hi));
  }
  const topResults = await Promise.all(tops);
  const values = topResults.map((r, i) => topValues(r, i, e.topN));
  const allTime = topResults.map((r, i) => {
    const f = col(r, fieldItem(i));
    const m = col(r, MEASURE);
    return new Map(r.rows.filter((row) => row[f] !== null).map((row) => [nodeId(i, row[f]), num(row[m])]));
  });
  if (!level) {
    const [overall, ...valueTotals] = await Promise.all([
      run(queries.overall(e, 'month'), 1),
      ...e.fields.map((_, i) => run(queries.values(e, i, values[i]), e.topN + 1))
    ]);
    return {
      level,
      periods: [],
      overall: [],
      values,
      allTime,
      series: e.fields.map(() => new Map()),
      valueTotals,
      grandTotal: num(overall.rows[0]?.[col(overall, MEASURE)] ?? 0)
    };
  }
  const [overallR, ...seriesR] = await Promise.all([
    run(queries.overall(e, level), MAX_PERIODS),
    ...e.fields.map((_, i) => (values[i].length ? run(queries.series(e, i, values[i], level as DateLevel), e.topN * MAX_PERIODS) : Promise.resolve(null)))
  ]);
  const { periods, values: overall } = periodsOf(overallR);
  const series = seriesR.map((r, i) => (r ? seriesOf(r, i, periods) : new Map<string, number[]>()));
  return { level, periods, overall, values, allTime, series };
}

/** Loads the links for a window (and the window before it) and assembles the graph. */
export async function loadWindow(e: Exploration, base: Base, run: Runner, window: TimeWindow | null): Promise<GraphData> {
  const pairs = fieldPairs(e.fields.length);
  const level = base.level ?? 'month';
  const w = base.level && window ? window : null;
  const pw = w ? previousWindow(w) : null;
  const all: TimeWindow = { from: 0, to: Math.max(0, base.periods.length - 1) };
  const load = (win: TimeWindow): Promise<QueryResult>[] =>
    pairs.map(([i, j]) =>
      base.values[i].length && base.values[j].length
        ? run(queries.pair(e, i, j, base.values[i], base.values[j], level, base.periods, win), e.topN * e.topN + 1)
        : Promise.resolve(emptyResult())
    );
  const [now, prev] = await Promise.all([Promise.all(load(w ?? all)), pw ? Promise.all(load(pw)) : Promise.resolve(undefined)]);
  return assemble(e, {
    values: base.values,
    allTime: base.allTime,
    series: base.series,
    periods: base.periods,
    overall: base.overall,
    pairs: now,
    pairsPrev: prev,
    valueTotals: base.valueTotals,
    window: w,
    grandTotal: base.grandTotal
  });
}

function emptyResult(): QueryResult {
  return { columns: [], rows: [], truncated: false, limit: 0, warnings: [], elapsedMs: 0 };
}

/** Score used to pick which links to draw. */
export function surprise(e: GEdge): number {
  return e.lift > 0 ? Math.abs(Math.log(e.lift)) * Math.sqrt(e.share) : 0;
}

/**
 * The links worth drawing: for each node, its `perNode` best links by strength, surprise, or both,
 * ignoring pairs below `minShare` of the total so tiny coincidences do not clutter the picture.
 */
export function visibleEdges(g: GraphData, mode: Exploration['links'], perNode = 5, minShare = 0.002): GEdge[] {
  const keep = new Set<string>();
  const candidates = g.edges.filter((e) => e.share >= minShare);
  const byNode = new Map<string, GEdge[]>();
  for (const e of candidates) {
    for (const n of [e.a, e.b]) {
      const list = byNode.get(n);
      if (list) list.push(e);
      else byNode.set(n, [e]);
    }
  }
  const scorers: ((e: GEdge) => number)[] = mode === 'strongest' ? [(e) => e.m] : mode === 'surprising' ? [surprise] : [(e) => e.m, surprise];
  for (const list of byNode.values()) {
    for (const score of scorers) {
      const take = mode === 'both' ? Math.ceil(perNode / 2) : perNode;
      [...list]
        .sort((x, y) => score(y) - score(x))
        .slice(0, take)
        .forEach((e) => keep.add(e.id));
    }
  }
  return candidates.filter((e) => keep.has(e.id));
}
