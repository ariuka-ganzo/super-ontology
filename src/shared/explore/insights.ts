// Finds insights in an Explore graph: gaps between what you would expect and what happened,
// ranked by size and importance, each with a plain-language explanation. See docs/EXPLORE.md.
import type { GEdge, GNode, GraphData } from './graph';

export type InsightKind = 'hiddenLink' | 'avoidedPair' | 'mover' | 'shiftingLink' | 'outlier' | 'spike' | 'concentration' | 'structure';

/**
 * Field pairs where one field's values each sit almost entirely under one value of the other, such as
 * city within region. Their links say "this belongs to that", which is structure, not a surprise.
 * Returns [child, parent] field index pairs.
 */
export function hierarchies(g: GraphData, purity = 0.95): [number, number][] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const fields = [...new Set(g.nodes.map((n) => n.field))];
  const out: [number, number][] = [];
  for (const child of fields)
    for (const parent of fields) {
      if (child === parent) continue;
      let mass = 0;
      let pure = 0;
      let links = 0;
      for (const n of g.nodes) {
        if (n.field !== child) continue;
        let best = 0;
        let sum = 0;
        for (const e of g.edges) {
          const other = e.a === n.id ? e.b : e.b === n.id ? e.a : null;
          if (!other || (byId.get(other) as GNode).field !== parent) continue;
          sum += e.m;
          best = Math.max(best, e.m);
          links++;
        }
        if (sum <= 0) continue;
        mass += sum;
        pure += best;
      }
      const parents = g.nodes.filter((n) => n.field === parent).length;
      if (links && mass > 0 && pure / mass >= purity && parents > 1) out.push([child, parent]);
    }
  return out;
}

export interface Insight {
  id: string;
  kind: InsightKind;
  /** Short headline. */
  title: string;
  /** The evidence, in words and numbers. */
  detail: string;
  /** Higher is more important. Comparable across kinds. */
  score: number;
  /** Nodes and links to highlight. */
  nodes: string[];
  edges: string[];
  /** For spikes: the period index. */
  period?: number;
}

export interface Labels {
  /** A node's display text, for example "East". */
  node(n: GNode): string;
  /** A field's display name, for example "region". */
  field(i: number): string;
  /** A measure amount, for example "$1,234". */
  amount(v: number): string;
  /** A period label, for example "Mar 2025". */
  period(p: string): string;
}

const pct = (v: number, digits = 0): string => `${(v * 100).toFixed(digits)}%`;
const times = (v: number): string => (v >= 10 ? `${Math.round(v)}×` : `${v.toFixed(1)}×`);

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Robust z-scores against the median. Uses the median absolute deviation, or the mean absolute
 * deviation when more than half the values are identical (the median deviation is then zero).
 */
function robustZ(xs: number[]): { med: number; z: (v: number) => number } {
  const med = median(xs);
  const dev = xs.map((v) => Math.abs(v - med));
  const mad = median(dev);
  if (mad > 0) return { med, z: (v) => (0.6745 * (v - med)) / mad };
  const meanAd = dev.reduce((a, b) => a + b, 0) / (xs.length || 1);
  return { med, z: meanAd > 0 ? (v) => (v - med) / (1.2533 * meanAd) : () => 0 };
}

/** All insights for a graph, most important first. */
export function findInsights(g: GraphData, L: Labels, limit = 40): Insight[] {
  const out: Insight[] = [];
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const T = g.total;
  if (T <= 0) return [];
  const fields = [...new Set(g.nodes.map((n) => n.field))];

  // Parent-child field pairs (city within region): report the structure once, and do not treat
  // "Midfield goes with Central" as a surprise.
  const tree = hierarchies(g);
  const structural = (fa: number, fb: number): boolean => tree.some(([c, p]) => (c === fa && p === fb) || (c === fb && p === fa));
  for (const [child, parent] of tree) {
    if (tree.some(([c, p]) => c === parent && p === child)) {
      if (child > parent) continue; // One-to-one: say it once.
      out.push({
        id: `st:${child}:${parent}`,
        kind: 'structure',
        title: `${L.field(child)} and ${L.field(parent)} match one to one`,
        detail: `Each ${L.field(child)} value goes with a single ${L.field(parent)} value and the other way round, so they describe the same thing.`,
        score: 0.05,
        nodes: [],
        edges: []
      });
      continue;
    }
    out.push({
      id: `st:${child}:${parent}`,
      kind: 'structure',
      title: `Each ${L.field(child)} belongs to one ${L.field(parent)}`,
      detail: `Almost all of every ${L.field(child)} value's total goes with a single ${L.field(parent)}, so their links show the hierarchy rather than a surprise. Look for surprises across other fields.`,
      score: 0.05,
      nodes: [],
      edges: g.edges
        .filter((e) => {
          const fa = (byId.get(e.a) as GNode).field;
          const fb = (byId.get(e.b) as GNode).field;
          return (fa === child && fb === parent) || (fa === parent && fb === child);
        })
        .map((e) => e.id)
    });
  }

  // Hidden links and avoided pairs: lift far from 1, weighted by how much of the total is involved.
  for (const e of g.edges) {
    const a = byId.get(e.a) as GNode;
    const b = byId.get(e.b) as GNode;
    if (structural(a.field, b.field)) continue;
    const expected = (a.m / T) * (b.m / T);
    if (e.lift >= 1.5 && e.share >= 0.005) {
      out.push({
        id: `hl:${e.id}`,
        kind: 'hiddenLink',
        title: `${L.node(a)} and ${L.node(b)} go together ${times(e.lift)} more than expected`,
        detail: `${L.node(a)} is ${pct(a.m / T)} and ${L.node(b)} is ${pct(b.m / T)} of the total, so together they would be about ${pct(expected, 1)} if unrelated. They are ${pct(e.share, 1)} (${L.amount(e.m)}).`,
        score: Math.log(e.lift) * Math.sqrt(e.share) * 4,
        nodes: [a.id, b.id],
        edges: [e.id]
      });
    } else if (e.lift > 0 && e.lift <= 0.5 && expected >= 0.01) {
      out.push({
        id: `ap:${e.id}`,
        kind: 'avoidedPair',
        title: `${L.node(a)} and ${L.node(b)} rarely go together (${times(e.lift)} the expected amount)`,
        detail: `Both are large (${pct(a.m / T)} and ${pct(b.m / T)} of the total), so together they would be about ${pct(expected, 1)} if unrelated, but they are only ${pct(e.share, 1)}.`,
        score: -Math.log(e.lift) * Math.sqrt(expected) * 3,
        nodes: [a.id, b.id],
        edges: [e.id]
      });
    }
  }
  // Large pairs that never occur at all: present as nodes, absent as an edge.
  // (Only checked between fields that have at least one link, to avoid unrelated tables.)
  const linkedFields = new Set(g.edges.map((e) => `${(byId.get(e.a) as GNode).field}-${(byId.get(e.b) as GNode).field}`));
  const has = new Set(g.edges.map((e) => `${e.a}|${e.b}`));
  for (const fi of fields)
    for (const fj of fields) {
      if (fi >= fj || !linkedFields.has(`${fi}-${fj}`) || structural(fi, fj)) continue;
      const as = g.nodes.filter((n) => n.field === fi).slice(0, 5);
      const bs = g.nodes.filter((n) => n.field === fj).slice(0, 5);
      for (const a of as)
        for (const b of bs) {
          const expected = (a.m / T) * (b.m / T);
          if (expected < 0.02 || has.has(`${a.id}|${b.id}`)) continue;
          out.push({
            id: `ap0:${a.id}|${b.id}`,
            kind: 'avoidedPair',
            title: `${L.node(a)} and ${L.node(b)} never go together`,
            detail: `Both are large (${pct(a.m / T)} and ${pct(b.m / T)} of the total), so together they would be about ${pct(expected, 1)} if unrelated, but there is none.`,
            score: Math.sqrt(expected) * 3 * 2,
            nodes: [a.id, b.id],
            edges: []
          });
        }
    }

  // Movers: change against the previous window, as a share of the total.
  if (g.totalPrev !== undefined && g.totalPrev > 0) {
    for (const n of g.nodes) {
      if (n.mPrev === undefined) continue;
      const d = n.m - n.mPrev;
      const rel = n.mPrev > 0 ? d / n.mPrev : Infinity;
      if (Math.abs(d) / T < 0.01 || (Number.isFinite(rel) && Math.abs(rel) < 0.25)) continue;
      out.push({
        id: `mv:${n.id}`,
        kind: 'mover',
        title: `${L.node(n)} ${d > 0 ? 'grew' : 'fell'} ${Number.isFinite(rel) ? pct(Math.abs(rel)) : 'from nothing'}`,
        detail: `${L.amount(n.mPrev)} in the previous period, ${L.amount(n.m)} now (${d > 0 ? '+' : '−'}${L.amount(Math.abs(d))}).`,
        score: (Math.abs(d) / T) * 6 * Math.min(2, Number.isFinite(rel) ? 0.5 + Math.abs(rel) : 2),
        nodes: [n.id],
        edges: []
      });
    }
    // Shifting links: lift changed a lot between windows.
    for (const e of g.edges) {
      if (e.liftPrev === undefined || e.share < 0.005) continue;
      if (structural((byId.get(e.a) as GNode).field, (byId.get(e.b) as GNode).field)) continue;
      const shift = Math.log(e.lift / e.liftPrev);
      if (Math.abs(shift) < Math.log(1.6)) continue;
      const a = byId.get(e.a) as GNode;
      const b = byId.get(e.b) as GNode;
      out.push({
        id: `sl:${e.id}`,
        kind: 'shiftingLink',
        title: `The link between ${L.node(a)} and ${L.node(b)} ${shift > 0 ? 'strengthened' : 'weakened'}`,
        detail: `They went together ${times(e.liftPrev)} the expected amount in the previous period and ${times(e.lift)} now.`,
        score: Math.abs(shift) * Math.sqrt(e.share) * 3,
        nodes: [a.id, b.id],
        edges: [e.id]
      });
    }
  }

  // Outliers within a field: robust z-score (median and median absolute deviation).
  for (const f of fields) {
    const ns = g.nodes.filter((n) => n.field === f);
    if (ns.length < 6) continue;
    const { med, z: zOf } = robustZ(ns.map((n) => n.m));
    if (med <= 0) continue;
    for (const n of ns) {
      const z = zOf(n.m);
      if (z < 3.5) continue;
      out.push({
        id: `ol:${n.id}`,
        kind: 'outlier',
        title: `${L.node(n)} stands out among ${L.field(f)} values: ${times(n.m / med)} the typical one`,
        detail: `${L.amount(n.m)}, against a typical (median) ${L.field(f)} of ${L.amount(med)}.`,
        score: Math.min(z, 12) * 0.05 + (n.m / T) * 2,
        nodes: [n.id],
        edges: []
      });
    }
  }

  // Spikes and dips: a period far from the value's usual level, within the window when there is one.
  if (g.periods.length >= 8) {
    const lo = g.window?.from ?? 0;
    const hi = g.window?.to ?? g.periods.length - 1;
    for (const n of g.nodes) {
      if (n.m / T < 0.01) continue;
      const s = n.series;
      const { med, z: zOf } = robustZ(s);
      if (med <= 0) continue;
      let best = -1;
      let bestZ = 0;
      for (let k = lo; k <= hi; k++) {
        const z = zOf(s[k]);
        if (Math.abs(z) > Math.abs(bestZ)) {
          bestZ = z;
          best = k;
        }
      }
      if (best < 0 || Math.abs(bestZ) < 4) continue;
      const up = bestZ > 0;
      out.push({
        id: `sp:${n.id}:${best}`,
        kind: 'spike',
        title: `${L.node(n)} ${up ? 'spiked' : 'dipped'} in ${L.period(g.periods[best])}`,
        detail: `${L.amount(s[best])}, against a usual ${L.amount(med)} per period (${times(s[best] / med)}).`,
        score: Math.min(Math.abs(bestZ), 15) * 0.04 * Math.sqrt(n.m / T) * 3,
        nodes: [n.id],
        edges: [],
        period: best
      });
    }
  }

  // Concentration: a few values hold most of the total.
  for (const f of fields) {
    const ns = g.nodes.filter((n) => n.field === f).sort((a, b) => b.m - a.m);
    if (ns.length < 8) continue;
    const k = Math.max(1, Math.round(ns.length * 0.1));
    const share = ns.slice(0, k).reduce((a, n) => a + n.m, 0) / T;
    if (share < 0.35) continue;
    out.push({
      id: `cc:${f}`,
      kind: 'concentration',
      title: `The top ${k} ${L.field(f)} value${k > 1 ? 's are' : ' is'} ${pct(share)} of the total`,
      detail: `${ns
        .slice(0, k)
        .map((n) => `${L.node(n)} ${pct(n.m / T)}`)
        .join(', ')}. An even spread over the ${ns.length} values shown would be ${pct(k / ns.length)}.`,
      score: (share - k / ns.length) * 0.8,
      nodes: ns.slice(0, k).map((n) => n.id),
      edges: []
    });
  }

  // Structure notes are always listed, after the ranked findings.
  const ranked = out.filter((i) => i.kind !== 'structure').sort((a, b) => b.score - a.score);
  return [...ranked.slice(0, limit), ...out.filter((i) => i.kind === 'structure')];
}

export interface Driver {
  node: GNode;
  /** Share of the selected node's measure that goes with this value. */
  within: number;
  /** Share of the overall total that goes with this value. */
  overall: number;
  lift: number;
  edge: GEdge;
}

/**
 * What makes a node different: for each other field, the values it goes with more (and less) than
 * everything else does. Computed from links already loaded.
 */
export function explainNode(g: GraphData, id: string): { field: number; over: Driver[]; under: Driver[] }[] {
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const self = byId.get(id);
  if (!self || self.m <= 0 || g.total <= 0) return [];
  const groups = new Map<number, Driver[]>();
  for (const e of g.edges) {
    if (e.a !== id && e.b !== id) continue;
    const other = byId.get(e.a === id ? e.b : e.a) as GNode;
    const d: Driver = { node: other, within: e.m / self.m, overall: other.m / g.total, lift: e.lift, edge: e };
    const list = groups.get(other.field);
    if (list) list.push(d);
    else groups.set(other.field, [d]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([field, ds]) => ({
      field,
      over: ds
        .filter((d) => d.lift > 1.15 && d.within >= 0.02)
        .sort((a, b) => b.within - b.overall - (a.within - a.overall))
        .slice(0, 4),
      under: ds
        .filter((d) => d.lift < 0.85 && d.overall >= 0.02)
        .sort((a, b) => a.within - a.overall - (b.within - b.overall))
        .slice(0, 3)
    }));
}
