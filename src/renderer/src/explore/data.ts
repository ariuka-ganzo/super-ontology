// Running Explore's queries, labelling its values, and suggesting a first exploration.
import { formatDate, formatNumber, formatValue } from '@shared/format';
import type { Runner } from '@shared/explore/graph';
import type { Labels } from '@shared/explore/insights';
import type { DateLevel, Exploration, FieldRef, Model, QueryResult, VizSpec } from '@shared/types';
import { fieldInfo, listFields, type FieldInfo } from '../fields';
import { newId } from '../ids';

const cache = new Map<string, Promise<QueryResult>>();
const CACHE_LIMIT = 400;

/**
 * Runs view queries through the main process. Results are cached by query, model and data version,
 * so moving the timeline back to a window already seen costs nothing.
 */
export function makeRunner(model: Model, dataVersion: number): Runner {
  const modelKey = JSON.stringify(model);
  return (spec: VizSpec, maxRows: number) => {
    const key = `${dataVersion}|${maxRows}|${JSON.stringify(spec)}|${modelKey}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const p = window.ontology.query({ requestId: newId('xq'), model, spec, maxRows });
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    return p;
  };
}

export function fieldName(model: Model, ref: FieldRef): string {
  return fieldInfo(model, ref)?.name ?? '?';
}

export function makeLabels(model: Model, e: Exploration, level: DateLevel | null): Labels & { value(field: number, v: unknown): string } {
  const infos = e.fields.map((f) => fieldInfo(model, f));
  const value = (field: number, v: unknown): string =>
    v === null || v === undefined ? '(blank)' : formatValue(v as string | number | boolean, infos[field]?.dataType ?? 'string');
  return {
    value,
    node: (n) => value(n.field, n.value),
    field: (i) => infos[i]?.name ?? `field ${i + 1}`,
    // Compact with up to two decimals (1.26M), so changes between amounts stay visible.
    amount: (v) =>
      Math.abs(v) >= 100_000
        ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(v)
        : formatNumber(v, { style: 'number', decimals: Math.abs(v) < 10 && v % 1 ? 2 : 0 }),
    period: (p) => (level === 'week' ? `the week of ${formatDate(p, 'day')}` : formatDate(p, level ?? 'day'))
  };
}

const IDISH = /(^|_|\s)(id|key|code|uuid|guid)$/i;
// Most to least likely to be the measure people care about.
const MEASURE_HINTS = [/sales|revenue|turnover/i, /amount|value|total|spend/i, /profit|margin|cost|price/i, /quantity|qty|units|count/i];
const DATE_HINT = /date|day|time|created|ordered|month/i;

/**
 * A first exploration for a model: up to four text fields with a useful number of distinct values,
 * the most likely measure, and a date field from the same table as the measure where possible.
 */
export async function suggestExploration(model: Model): Promise<Exploration | null> {
  const fields = listFields(model).filter((f) => f.ref.kind === 'column' && !f.error);
  const textDims = fields.filter((f) => f.role === 'dimension' && f.dataType === 'string' && !IDISH.test(f.name));
  if (!textDims.length) return null;
  const numeric = fields.filter((f) => f.role === 'measure' && (f.dataType === 'integer' || f.dataType === 'number'));
  const measureInfo: FieldInfo | undefined = MEASURE_HINTS.map((re) => numeric.find((f) => re.test(f.name))).find(Boolean) ?? numeric[0];
  const dates = fields.filter((f) => f.dataType === 'date' || f.dataType === 'datetime');
  const sameTable = (f: FieldInfo): boolean => !!measureInfo && f.tableId === measureInfo.tableId;
  const time = dates.find((f) => sameTable(f) && DATE_HINT.test(f.name)) ?? dates.find(sameTable) ?? dates.find((f) => DATE_HINT.test(f.name)) ?? dates[0];

  // Distinct values per candidate, to prefer fields with a readable number of values.
  const counts = await Promise.all(
    textDims.slice(0, 24).map(async (f) => {
      try {
        const r = await window.ontology.query({
          requestId: newId('xs'),
          model,
          spec: { chartType: 'kpi', columns: [], rows: [{ id: 'n', field: f.ref, role: 'measure', agg: 'COUNTD' }], tooltip: [], filters: [] },
          maxRows: 1
        });
        return { f, n: Number(r.rows[0]?.[0] ?? 0) };
      } catch {
        return { f, n: 0 };
      }
    })
  );
  const usable = counts.filter((c) => c.n >= 2 && c.n <= 5000);
  if (!usable.length) return null;
  // Closest to about a dozen values first, then larger ones, so the graph has both broad and detailed fields.
  usable.sort((a, b) => Math.abs(Math.log(a.n / 12)) - Math.abs(Math.log(b.n / 12)));
  const chosen = usable.slice(0, 4).map((c) => c.f.ref);
  const measure = measureInfo ? { field: measureInfo.ref, agg: 'SUM' as const } : { field: chosen[0], agg: 'COUNT' as const };
  return {
    id: newId('x'),
    name: 'Exploration 1',
    fields: chosen,
    measure,
    ...(time ? { time: time.ref } : {}),
    topN: 30,
    links: 'both',
    colorBy: 'field'
  };
}
