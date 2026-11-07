import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { compileViz, type CompileOptions, type CompiledQuery } from '@shared/compiler/compile';
import { duckTypeToDataType, engineTableName } from '@shared/compiler/sql';
import type { ColumnDef, Model, Scalar, TableDef, VizSpec } from '@shared/types';
import { toScalar } from '../../../src/main/engine/values';

export type Col = [name: string, duckType: string];

function lit(v: Scalar, type: string): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = `'${String(v).replace(/'/g, "''")}'`;
  return type === 'VARCHAR' ? s : `CAST(${s} AS ${type})`;
}

export class TestDb {
  private constructor(
    private readonly conn: DuckDBConnection,
    public readonly model: Model
  ) {}

  static async create(): Promise<TestDb> {
    const db = await DuckDBInstance.create(':memory:', { enable_external_access: 'false' });
    return new TestDb(await db.connect(), { tables: [], relationships: [], calcs: [] });
  }

  async table(id: string, name: string, cols: Col[], rows: Scalar[][]): Promise<TableDef> {
    const values = rows.map((r) => `(${r.map((v, i) => lit(v, cols[i][1])).join(', ')})`).join(', ');
    const colList = cols.map(([n]) => `"${n}"`).join(', ');
    const casts = cols.map(([n, t]) => `CAST("${n}" AS ${t}) AS "${n}"`).join(', ');
    await this.conn.run(`CREATE TABLE "${engineTableName(id)}" AS SELECT ${casts} FROM (VALUES ${values}) AS v(${colList})`);
    const columns: ColumnDef[] = cols.map(([n, t]) => ({ name: n, sourceType: t, type: duckTypeToDataType(t) }));
    const def: TableDef = { id, name, source: { path: `${name}.csv`, format: 'csv' }, columns, rowCount: rows.length };
    this.model.tables.push(def);
    return def;
  }

  async run(q: CompiledQuery): Promise<Record<string, Scalar>[]> {
    const reader = await this.conn.runAndReadAll(q.sql, q.params);
    const types = reader.columnTypes();
    const names = reader.columnNames();
    return reader.getRowsJS().map((r) => {
      const o: Record<string, Scalar> = {};
      r.forEach((v, i) => {
        const col = q.columns.find((c) => c.alias === names[i]);
        o[col ? col.key : names[i]] = toScalar(v, types[i]);
      });
      return o;
    });
  }

  async viz(spec: Partial<VizSpec>, opts?: CompileOptions): Promise<{ rows: Record<string, Scalar>[]; q: CompiledQuery }> {
    const full: VizSpec = { chartType: 'auto', columns: [], rows: [], tooltip: [], filters: [], ...spec };
    const q = compileViz(full, this.model, opts);
    return { rows: await this.run(q), q };
  }

  async sql(text: string): Promise<Scalar[][]> {
    const r = await this.conn.runAndReadAll(text);
    const types = r.columnTypes();
    return r.getRowsJS().map((row) => row.map((v, i) => toScalar(v, types[i])));
  }
}
