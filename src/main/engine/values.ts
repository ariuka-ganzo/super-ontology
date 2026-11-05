import type { DuckDBType } from '@duckdb/node-api';
import type { Scalar } from '@shared/types';

/** Converts a value read from DuckDB (via getRowsJS) into a JSON-safe scalar for IPC. */
export function toScalar(v: unknown, type: DuckDBType): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v.toString();
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const iso = v.toISOString();
    const t = type.toString();
    if (t === 'DATE') return iso.slice(0, 10);
    return iso.slice(0, 19);
  }
  // Lists, structs, blobs and other complex values are shown as text.
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    return String(v);
  }
}
