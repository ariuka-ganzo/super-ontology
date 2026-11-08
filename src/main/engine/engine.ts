/**
 * The DuckDB engine. It runs in the main process and uses two DuckDB instances:
 *
 * - The query instance holds the imported tables and runs every query the compiler produces.
 *   It is created with `enable_external_access = false`, so it cannot read or write files or
 *   install extensions, whatever SQL reaches it.
 * - The reader instance only ever runs the fixed import statements in this file, with the path of a
 *   file the user chose bound as a parameter. Rows are streamed from it into the query instance
 *   as DuckDB data chunks.
 *
 * Neither instance auto-installs or auto-loads extensions. Parquet and JSON readers are built in.
 */
import { DuckDBInstance, type DuckDBConnection, type DuckDBResult, type DuckDBType } from '@duckdb/node-api';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { CardinalityResult, ColumnProfile, ImportResult, PrepareResult, PreviewResult, QueryRequest } from '@shared/api';
import { compileViz, type CompiledQuery } from '@shared/compiler/compile';
import { duckTypeToDataType, engineTableName, quoteIdent as q, sqlType } from '@shared/compiler/sql';
import { classifyCardinality } from '@shared/model/relationships';
import { appendSources, compilePrep, type PrepColumn, type PrepSource } from '@shared/prep/prep';
import type { ColumnDef, DataType, Model, PrepStep, QueryResult, Relationship, Scalar, TableDef, TableSource } from '@shared/types';
import { readExcelToCsv } from './excel';
import { toScalar } from './values';

const LOCKED = {
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  allow_community_extensions: 'false'
};

/** File extensions the engine will read for each format. Anything else is refused. */
export const FORMAT_EXTENSIONS: Record<TableSource['format'], string[]> = {
  csv: ['.csv', '.txt'],
  tsv: ['.tsv', '.tab', '.txt'],
  parquet: ['.parquet', '.pq'],
  json: ['.json', '.jsonl', '.ndjson'],
  excel: ['.xlsx']
};

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: 'missing' | 'cancelled' | 'invalid' | 'failed' = 'failed'
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export class Engine {
  private readonly running = new Map<string, DuckDBConnection>();
  private readonly cancelled = new Set<string>();

  private constructor(
    private readonly query_: DuckDBInstance,
    private readonly reader: DuckDBInstance
  ) {}

  static async create(): Promise<Engine> {
    const query = await DuckDBInstance.create(':memory:', { ...LOCKED, enable_external_access: 'false' });
    const reader = await DuckDBInstance.create(':memory:', LOCKED);
    // Lock the query instance's configuration so later SQL cannot turn file access back on.
    const c = await query.connect();
    await c.run('SET lock_configuration = true');
    c.closeSync();
    return new Engine(query, reader);
  }

  private async withQuery<T>(fn: (c: DuckDBConnection) => Promise<T>): Promise<T> {
    const c = await this.query_.connect();
    try {
      return await fn(c);
    } finally {
      c.closeSync();
    }
  }

  // ------------------------------------------------------------------ import

  /**
   * Imports a file for `tableId`, replacing any previous data, then applies the table's cleaning steps.
   * The file's rows are kept unchanged in a raw table, so steps can be edited without reading the file again.
   */
  async importTable(tableId: string, source: TableSource, steps: PrepStep[] = []): Promise<ImportResult> {
    const started = Date.now();
    // Only data files can be imported, whatever path reaches the engine (for example from a project file).
    if (!FORMAT_EXTENSIONS[source.format]?.includes(extname(source.path).toLowerCase()))
      throw new EngineError(`${source.path} does not look like a ${source.format.toUpperCase()} file, so it was not imported.`, 'invalid');
    try {
      const st = await fs.stat(source.path);
      if (!st.isFile()) throw new EngineError(`${source.path} is not a file`, 'invalid');
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new EngineError(`The file ${source.path} was not found. It may have been moved, renamed or deleted.`, 'missing');
    }

    let tempDir: string | undefined;
    let path = source.path;
    let format = source.format;
    if (format === 'excel') {
      tempDir = await fs.mkdtemp(join(tmpdir(), 'ontology-xlsx-'));
      path = join(tempDir, 'sheet.csv');
      await readExcelToCsv(source.path, path, source.sheet);
      format = 'csv';
    }

    const rc = await this.reader.connect();
    try {
      const reader = readerSql(format);
      // Describe first, so nested JSON values can be converted to text.
      const desc = await rc.runAndReadAll(`DESCRIBE SELECT * FROM ${reader}`, [path]);
      const described = desc.getRowsJS().map((r) => ({ name: String(r[0]), type: String(r[1]) }));
      if (described.length === 0) throw new EngineError('The file has no columns', 'invalid');
      const select = described.map((c) => (isScalarType(c.type) ? q(c.name) : `CAST(${q(c.name)} AS VARCHAR) AS ${q(c.name)}`)).join(', ');
      const result = await rc.stream(`SELECT ${select} FROM ${reader}`, [path]);
      await this.copyInto(tableId, result);
      const prepared = await this.applySteps(tableId, steps);
      return { ...prepared, elapsedMs: Date.now() - started };
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new EngineError(`Could not read ${source.path}: ${cleanMessage(e)}`, 'invalid');
    } finally {
      rc.closeSync();
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async copyInto(tableId: string, result: DuckDBResult): Promise<number> {
    const names = result.columnNames();
    const types = result.columnTypes();
    const final = rawTableName(tableId);
    const staging = `${final}__loading`;
    return this.withQuery(async (c) => {
      await c.run(`DROP TABLE IF EXISTS ${q(staging)}`);
      await c.run(`CREATE TABLE ${q(staging)} (${names.map((n, i) => `${q(n)} ${types[i].toString()}`).join(', ')})`);
      let rows = 0;
      try {
        const app = await c.createAppender(staging);
        for (;;) {
          const chunk = await result.fetchChunk();
          if (!chunk || chunk.rowCount === 0) break;
          app.appendDataChunk(chunk);
          rows += chunk.rowCount;
        }
        app.flushSync();
        app.closeSync();
      } catch (e) {
        await c.run(`DROP TABLE IF EXISTS ${q(staging)}`);
        throw e;
      }
      // Swap in the new data only once it has fully loaded.
      await c.run(`DROP TABLE IF EXISTS ${q(final)}`);
      await c.run(`ALTER TABLE ${q(staging)} RENAME TO ${q(final)}`);
      return rows;
    });
  }

  /**
   * Builds the table that views query from the raw import and the cleaning steps. With no steps it is
   * a view of the raw table, so no data is copied. With steps it is a new table, built with bound
   * parameters and swapped in once complete. A step that does not fit, or fails when run, is reported
   * in `stepError`, and the table then reflects the steps before it.
   */
  async applySteps(tableId: string, steps: PrepStep[]): Promise<PrepareResult> {
    const raw = rawTableName(tableId);
    const final = engineTableName(tableId);
    return this.withQuery(async (c) => {
      if ((await relationType(c, raw)) === null) throw new EngineError('The table has no data loaded. Reload it from its source.', 'missing');
      const base: PrepSource = { ref: q(raw), columns: await describeColumns(c, q(raw)) };
      const others = new Map<string, PrepSource>();
      for (const id of appendSources(steps)) {
        const name = engineTableName(id);
        if (id !== tableId && (await relationType(c, name)) !== null) others.set(id, { ref: q(name), columns: await describeColumns(c, q(name)) });
      }
      let compiled = compilePrep(base, steps, (id) => others.get(id), tableId);
      let stepError = compiled.error ? { stepId: compiled.error.stepId, message: compiled.error.message } : undefined;
      const staging = `${final}__prep`;
      await dropRelation(c, staging);
      if (compiled.applied > 0) {
        // Run the steps; if one fails at run time (for example two appended columns that cannot be combined),
        // drop steps from the end until the rest run, and report the first step left out.
        for (;;) {
          try {
            await c.run(`CREATE TABLE ${q(staging)} AS ${compiled.sql}`, compiled.params);
            break;
          } catch (e) {
            const failed = steps[compiled.applied - 1];
            stepError = { stepId: failed.id, message: cleanMessage(e) };
            compiled = compilePrep(base, steps.slice(0, compiled.applied - 1), (id) => others.get(id), tableId);
            if (compiled.applied === 0) break;
          }
        }
      }
      await dropRelation(c, final);
      if (compiled.applied > 0) await c.run(`ALTER TABLE ${q(staging)} RENAME TO ${q(final)}`);
      else await c.run(`CREATE VIEW ${q(final)} AS SELECT * FROM ${q(raw)}`);
      const r = await c.runAndReadAll(`DESCRIBE SELECT * FROM ${q(final)}`);
      const columns: ColumnDef[] = r.getRowsJS().map((row) => {
        const t = String(row[1]);
        return { name: String(row[0]), sourceType: t, type: duckTypeToDataType(t) };
      });
      const count = await c.runAndReadAll(`SELECT COUNT(*) FROM ${q(final)}`);
      return { columns, rowCount: Number(count.getRowsJS()[0][0]), stepError };
    });
  }

  async dropTable(tableId: string): Promise<void> {
    await this.withQuery(async (c) => {
      await dropRelation(c, engineTableName(tableId));
      await dropRelation(c, `${engineTableName(tableId)}__prep`);
      await dropRelation(c, rawTableName(tableId));
    });
  }

  async hasTable(tableId: string): Promise<boolean> {
    return this.withQuery(async (c) => (await relationType(c, engineTableName(tableId))) !== null);
  }

  // ------------------------------------------------------------------ data view

  /**
   * Rows of a table for the data view. With `uptoStep`, shows the data as it is right after that
   * cleaning step instead of after all of them (type overrides are not applied then).
   */
  async preview(table: TableDef, limit: number, offset: number, uptoStep?: string): Promise<PreviewResult> {
    return this.withQuery(async (c) => {
      let src = typedSource(table);
      let params: Scalar[] = [];
      const steps = table.steps ?? [];
      const upto = uptoStep ? steps.findIndex((s) => s.id === uptoStep) : -1;
      if (upto >= 0) {
        const raw = rawTableName(table.id);
        const base: PrepSource = { ref: q(raw), columns: await describeColumns(c, q(raw)) };
        const others = new Map<string, PrepSource>();
        for (const id of appendSources(steps.slice(0, upto + 1))) {
          const name = engineTableName(id);
          if (id !== table.id && (await relationType(c, name)) !== null) others.set(id, { ref: q(name), columns: await describeColumns(c, q(name)) });
        }
        const compiled = compilePrep(base, steps.slice(0, upto + 1), (id) => others.get(id), table.id);
        src = `(${compiled.sql})`;
        params = compiled.params;
      }
      const n = params.length;
      const r = await c.runAndReadAll(`SELECT * FROM ${src} AS p LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, limit, offset]);
      const total = await c.runAndReadAll(
        upto >= 0 ? `SELECT COUNT(*) FROM ${src} AS p` : `SELECT COUNT(*) FROM ${q(engineTableName(table.id))}`,
        upto >= 0 ? params : []
      );
      return { columns: r.columnNames(), rows: convertRows(r.getRowsJS(), r.columnTypes()), total: Number(total.getRowsJS()[0][0]) };
    });
  }

  async profile(table: TableDef, column: string): Promise<ColumnProfile> {
    const col = table.columns.find((c) => c.name === column);
    if (!col) throw new EngineError(`Column ${column} not found`, 'invalid');
    const t = col.override ?? col.type;
    return this.withQuery(async (c) => {
      const src = typedSource(table, [col]);
      const x = q(col.name);
      const stats = await c.runAndReadAll(`SELECT COUNT(*), COUNT(*) - COUNT(${x}), COUNT(DISTINCT ${x}), MIN(${x}), MAX(${x}) FROM ${src}`);
      const [row] = convertRows(stats.getRowsJS(), stats.columnTypes());
      const [total, nulls, distinct, min, max] = row as [number, number, number, Scalar, Scalar];
      let histogram: { label: string; count: number }[] = [];
      let histogramKind: ColumnProfile['histogramKind'] = 'top';
      const numeric = t === 'integer' || t === 'number';
      const temporal = t === 'date' || t === 'datetime';
      if ((numeric || temporal) && min !== null && max !== null) {
        histogramKind = 'bins';
        const v = temporal ? `epoch(${x})` : `CAST(${x} AS DOUBLE)`;
        const bins = 20;
        const r = await c.runAndReadAll(
          `WITH b AS (SELECT MIN(${v}) AS lo, MAX(${v}) AS hi FROM ${src})
           SELECT CASE WHEN b.hi = b.lo THEN 0 ELSE LEAST(CAST(FLOOR((${v} - b.lo) / (b.hi - b.lo) * $1) AS INTEGER), $1 - 1) END AS bin,
             COUNT(*), ANY_VALUE(b.lo), ANY_VALUE(b.hi)
           FROM ${src}, b WHERE ${x} IS NOT NULL GROUP BY 1 ORDER BY 1`,
          [bins]
        );
        const rows = convertRows(r.getRowsJS(), r.columnTypes());
        const lo = Number(rows[0]?.[2] ?? 0);
        const hi = Number(rows[0]?.[3] ?? 0);
        const width = (hi - lo) / bins;
        const counts = new Map(rows.map((rr) => [rr[0] === null ? 0 : Number(rr[0]), Number(rr[1])]));
        const nb = hi === lo ? 1 : bins;
        histogram = Array.from({ length: nb }, (_, i) => {
          const start = lo + i * width;
          const label = temporal ? new Date(start * 1000).toISOString().slice(0, 10) : roundLabel(start);
          return { label, count: counts.get(i) ?? 0 };
        });
      } else {
        const r = await c.runAndReadAll(`SELECT CAST(${x} AS VARCHAR) AS v, COUNT(*) AS n FROM ${src} GROUP BY 1 ORDER BY 2 DESC, 1 ASC NULLS LAST LIMIT 10`);
        histogram = convertRows(r.getRowsJS(), r.columnTypes()).map((rr) => ({ label: rr[0] === null ? 'Null' : String(rr[0]), count: Number(rr[1]) }));
      }
      return { column, total, nulls, distinct, min, max, histogram, histogramKind };
    });
  }

  async cardinality(model: Model, rel: Omit<Relationship, 'id' | 'cardinality'>): Promise<CardinalityResult> {
    const from = model.tables.find((t) => t.id === rel.fromTable);
    const to = model.tables.find((t) => t.id === rel.toTable);
    const fc = from?.columns.find((c) => c.name === rel.fromColumn);
    const tc = to?.columns.find((c) => c.name === rel.toColumn);
    if (!from || !to || !fc || !tc) throw new EngineError('Relationship columns not found', 'invalid');
    return this.withQuery(async (c) => {
      const unique = async (t: TableDef, col: ColumnDef): Promise<boolean> => {
        const r = await c.runAndReadAll(`SELECT COUNT(${q(col.name)}) = COUNT(DISTINCT ${q(col.name)}) FROM ${typedSource(t, [col])}`);
        return Boolean(r.getRowsJS()[0][0]);
      };
      const fromUnique = await unique(from, fc);
      const toUnique = await unique(to, tc);
      const m = await c.runAndReadAll(
        `SELECT COUNT(*), COUNT(*) FILTER (WHERE ${q(fc.name)} IN (SELECT ${q(tc.name)} FROM ${typedSource(to, [tc])}))
         FROM ${typedSource(from, [fc])} WHERE ${q(fc.name)} IS NOT NULL`
      );
      const [all, matched] = m.getRowsJS()[0].map(Number);
      return { cardinality: classifyCardinality(fromUnique, toUnique), fromUnique, toUnique, matchRate: all === 0 ? 0 : matched / all };
    });
  }

  // ------------------------------------------------------------------ queries

  compile(req: QueryRequest, noLimit = false): CompiledQuery {
    return compileViz(req.spec, req.model, { externalFilters: req.externalFilters, maxRows: req.maxRows, noLimit });
  }

  /** Runs a view query. It runs on DuckDB's own threads, so the main process stays responsive. */
  async query(req: QueryRequest): Promise<QueryResult> {
    const compiled = this.compile(req);
    const started = Date.now();
    const c = await this.query_.connect();
    this.running.set(req.requestId, c);
    try {
      if (this.cancelled.delete(req.requestId)) throw new EngineError('Query cancelled', 'cancelled');
      const r = await c.runAndReadAll(compiled.sql, compiled.params);
      const rows = convertRows(r.getRowsJS(), r.columnTypes());
      const truncated = rows.length > compiled.maxRows;
      if (truncated) rows.length = compiled.maxRows;
      return { columns: compiled.columns, rows, truncated, limit: compiled.maxRows, warnings: compiled.warnings, elapsedMs: Date.now() - started };
    } catch (e) {
      if (e instanceof EngineError) throw e;
      const msg = cleanMessage(e);
      if (/interrupt/i.test(msg)) throw new EngineError('Query cancelled', 'cancelled');
      throw new EngineError(msg);
    } finally {
      this.running.delete(req.requestId);
      this.cancelled.delete(req.requestId);
      c.closeSync();
    }
  }

  cancel(requestId: string): void {
    const c = this.running.get(requestId);
    if (c) c.interrupt();
    else {
      // The query may not have started yet; remember the cancel briefly.
      this.cancelled.add(requestId);
      setTimeout(() => this.cancelled.delete(requestId), 10_000).unref?.();
    }
  }

  /** Streams the full result of a view query (no row limit) as CSV text chunks. */
  async *queryCsv(req: QueryRequest): AsyncGenerator<string> {
    const compiled = this.compile(req, true);
    const c = await this.query_.connect();
    try {
      const result = await c.stream(compiled.sql, compiled.params);
      const names = result.columnNames();
      const labels = names.map((n) => compiled.columns.find((col) => col.alias === n)?.label ?? n);
      yield labels.map(csvCell).join(',') + '\r\n';
      const types = result.columnTypes();
      for await (const jsRows of result.yieldRowsJs()) {
        if (jsRows.length === 0) continue;
        const rows = convertRows(jsRows, types);
        yield rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
      }
    } finally {
      c.closeSync();
    }
  }

  /** Runs SQL on the query instance. For tests and the security self-check only; never exposed over IPC. */
  async unsafeRawForTests(sql: string): Promise<Scalar[][]> {
    return this.withQuery(async (c) => {
      const r = await c.runAndReadAll(sql);
      return convertRows(r.getRowsJS(), r.columnTypes());
    });
  }

  close(): void {
    for (const c of this.running.values()) c.interrupt();
    this.query_.closeSync();
    this.reader.closeSync();
  }
}

/** The unchanged rows of the file a table was imported from. Views never read it directly. */
function rawTableName(tableId: string): string {
  return `${engineTableName(tableId)}__raw`;
}

/** 'table', 'view', or null when there is no relation with that name. */
async function relationType(c: DuckDBConnection, name: string): Promise<'table' | 'view' | null> {
  const r = await c.runAndReadAll('SELECT table_type FROM information_schema.tables WHERE table_name = $1', [name]);
  const t = r.getRowsJS()[0]?.[0];
  return t === undefined ? null : String(t) === 'VIEW' ? 'view' : 'table';
}

async function dropRelation(c: DuckDBConnection, name: string): Promise<void> {
  const t = await relationType(c, name);
  if (t) await c.run(`DROP ${t === 'view' ? 'VIEW' : 'TABLE'} ${q(name)}`);
}

async function describeColumns(c: DuckDBConnection, ref: string): Promise<PrepColumn[]> {
  const r = await c.runAndReadAll(`DESCRIBE SELECT * FROM ${ref}`);
  return r.getRowsJS().map((row) => ({ name: String(row[0]), type: duckTypeToDataType(String(row[1])) }));
}

function readerSql(format: TableSource['format']): string {
  switch (format) {
    case 'csv':
      return 'read_csv($1, header = true, sample_size = 20480)';
    case 'tsv':
      return "read_csv($1, header = true, delim = '\t', sample_size = 20480)";
    case 'parquet':
      return 'read_parquet($1)';
    case 'json':
      return 'read_json_auto($1)';
    default:
      throw new EngineError(`Unsupported format ${format}`, 'invalid');
  }
}

function isScalarType(t: string): boolean {
  const u = t.toUpperCase();
  return !(u.includes('STRUCT') || u.includes('[]') || u.startsWith('MAP') || u.startsWith('UNION') || u === 'JSON' || u.startsWith('LIST') || u === 'BLOB');
}

/** SELECT over an engine table with type overrides applied. */
function typedSource(table: TableDef, only?: ColumnDef[]): string {
  const cols = only ?? table.columns;
  const select = cols
    .map((c) => (c.override && c.override !== c.type ? `TRY_CAST(${q(c.name)} AS ${sqlType(c.override as DataType)}) AS ${q(c.name)}` : q(c.name)))
    .join(', ');
  return `(SELECT ${select || '*'} FROM ${q(engineTableName(table.id))})`;
}

function convertRows(rows: unknown[][], types: DuckDBType[]): Scalar[][] {
  return rows.map((r) => r.map((v, i) => toScalar(v, types[i])));
}

function roundLabel(v: number): string {
  const abs = Math.abs(v);
  return String(abs >= 100 ? Math.round(v) : abs >= 1 ? Math.round(v * 100) / 100 : Math.round(v * 10000) / 10000);
}

/** Escapes a CSV cell. Text that a spreadsheet would run as a formula is prefixed with an apostrophe. */
export function csvCell(v: Scalar): string {
  if (v === null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function cleanMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.split('\n')[0].replace(/^(Error|Binder Error|Parser Error|Conversion Error|Invalid Input Error|IO Error): /, '');
}
