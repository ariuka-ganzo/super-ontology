import type { DataType, Scalar } from '../types';

/** Quotes an SQL identifier. Every identifier the compiler emits goes through this. */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** The engine stores each model table in a table named after its id. */
export function engineTableName(tableId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tableId)) throw new Error(`Invalid table id: ${tableId}`);
  return `t_${tableId}`;
}

export function sqlType(t: DataType): string {
  switch (t) {
    case 'string':
      return 'VARCHAR';
    case 'integer':
      return 'BIGINT';
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
  }
}

/** Collects bound parameter values. Values never appear in SQL text. */
export class Params {
  readonly values: Scalar[] = [];

  /** Adds a value and returns a typed placeholder such as CAST($3 AS DOUBLE). */
  add(value: Scalar, type: string): string {
    if (value === null) return `CAST(NULL AS ${type})`;
    this.values.push(value);
    return `CAST($${this.values.length} AS ${type})`;
  }

  /** Adds a value with a type picked from the JavaScript value. */
  addAuto(value: Scalar): string {
    if (value === null) return 'NULL';
    if (typeof value === 'number') return this.add(value, numberType(value));
    if (typeof value === 'boolean') return this.add(value, 'BOOLEAN');
    return this.add(value, 'VARCHAR');
  }
}

/**
 * Drops bound values the SQL never references and renumbers the placeholders that remain.
 * The compiler can add a value and then discard the SQL that used it (for example when an LOD
 * expression turns out to be a duplicate). Quoted identifiers are skipped, so a column whose name
 * looks like a placeholder is never rewritten.
 */
export function compactParams(sql: string, values: Scalar[]): { sql: string; params: Scalar[] } {
  const params: Scalar[] = [];
  const renumber = new Map<number, number>();
  const out = sql.replace(/"(?:[^"]|"")*"|CAST\(\$(\d+) AS /g, (m, n?: string) => {
    if (n === undefined) return m;
    const old = Number(n);
    let next = renumber.get(old);
    if (next === undefined) {
      params.push(values[old - 1]);
      next = params.length;
      renumber.set(old, next);
    }
    return `CAST($${next} AS `;
  });
  return { sql: out, params };
}

export function numberType(v: number): string {
  if (Number.isInteger(v)) return Math.abs(v) < 2 ** 31 ? 'INTEGER' : 'BIGINT';
  return 'DOUBLE';
}

/** Maps a DuckDB type name to the app's data types. */
export function duckTypeToDataType(t: string): DataType {
  const u = t.toUpperCase();
  if (u === 'BOOLEAN') return 'boolean';
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT)$/.test(u)) return 'integer';
  if (/^(FLOAT|DOUBLE|REAL)$/.test(u) || u.startsWith('DECIMAL')) return 'number';
  if (u === 'DATE') return 'date';
  if (u.startsWith('TIMESTAMP')) return 'datetime';
  return 'string';
}
