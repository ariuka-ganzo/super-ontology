/**
 * Reads tables from databases: SQLite files, PostgreSQL and MySQL servers.
 *
 * It uses its own DuckDB instance with DuckDB's official connectors, which ship with the app
 * (scripts/fetch-duckdb-extensions.mjs) and are loaded from files; DuckDB checks their signatures
 * and nothing is ever downloaded. Like the file reader, this instance only runs the fixed statements
 * in this file. Every database is attached READ_ONLY.
 *
 * DuckDB's ATTACH and CREATE SECRET take no bound parameters, so connection settings are written into
 * those two statements as escaped string literals (`literal` below), checked by the IPC schema first.
 * The password only ever goes into a temporary secret, never into a connection string, so DuckDB's
 * error messages do not contain it; messages are also scrubbed of it before they leave this file.
 * A query typed by the user is passed to the server as a bound parameter.
 */
import { DuckDBInstance, type DuckDBConnection, type DuckDBResult } from '@duckdb/node-api';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { quoteIdent as q } from '@shared/compiler/sql';
import type { DbTable } from '@shared/api';
import type { TableSource } from '@shared/types';

export type { DbTable };

export const CONNECTORS = ['sqlite_scanner', 'postgres_scanner', 'mysql_scanner'];

export class ConnectorError extends Error {
  constructor(
    message: string,
    public readonly code: 'missing' | 'invalid' | 'failed' | 'password' | 'unavailable' = 'failed'
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** An SQL string literal. Only used for connection settings, which DuckDB cannot take as parameters. */
export function literal(s: string): string {
  if (s.includes('\0')) throw new ConnectorError('Connection settings cannot contain a NUL character', 'invalid');
  return `'${s.replace(/'/g, "''")}'`;
}

/** Removes a password from an error message, in case a driver ever repeats it. */
export function scrub(message: string, password?: string): string {
  return password ? message.split(password).join('••••') : message;
}

function clean(e: unknown, password?: string): string {
  const m = e instanceof Error ? e.message : String(e);
  return scrub(
    m
      .replace(/^(IO|Invalid|Binder|Catalog|Parser) Error: /, '')
      // The connection string is always empty (settings go in a secret), so drop DuckDB's mention of it.
      .replace(/ (at|with parameters) ""/, '')
      .split('\n')[0],
    password
  );
}

export class Connector {
  private instance: Promise<DuckDBInstance> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private n = 0;

  constructor(private readonly extensionsDir: string) {}

  private async db(): Promise<DuckDBInstance> {
    this.instance ??= (async () => {
      for (const name of CONNECTORS) {
        try {
          await fs.access(join(this.extensionsDir, `${name}.duckdb_extension`));
        } catch {
          throw new ConnectorError(
            'Database connections are not included in this build of Super Ontology. Developers: run node scripts/fetch-duckdb-extensions.mjs.',
            'unavailable'
          );
        }
      }
      const db = await DuckDBInstance.create(':memory:', {
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
        allow_community_extensions: 'false'
      });
      const c = await db.connect();
      try {
        for (const name of CONNECTORS) await c.run(`LOAD ${literal(join(this.extensionsDir, `${name}.duckdb_extension`))}`);
      } finally {
        c.closeSync();
      }
      return db;
    })().catch((e) => {
      this.instance = null;
      throw e;
    });
    return this.instance;
  }

  /** Loads the connectors, which checks that they are present and correctly signed. Used by the smoke test. */
  async selfTest(): Promise<string> {
    await this.db();
    return CONNECTORS.join(',');
  }

  /** Runs `fn` with the source attached, one source at a time, and always detaches it afterwards. */
  private attached<T>(source: TableSource, password: string | undefined, fn: (c: DuckDBConnection, alias: string) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const db = await this.db();
      const c = await db.connect();
      const id = ++this.n;
      const alias = `src_${id}`;
      const secret = `sec_${id}`;
      let attachedOk = false;
      try {
        if (source.format === 'sqlite') {
          await c.run(`ATTACH ${literal(source.path)} AS ${q(alias)} (TYPE sqlite, READ_ONLY)`);
        } else if (source.format === 'postgres' || source.format === 'mysql') {
          const k = source.connection;
          if (!k) throw new ConnectorError('The connection settings are missing', 'invalid');
          if (password === undefined) throw new ConnectorError(`Enter the password for ${k.user} on ${k.host}`, 'password');
          await c.run(
            `CREATE TEMPORARY SECRET ${secret} (TYPE ${source.format}, HOST ${literal(k.host)}, PORT ${Math.trunc(k.port)}, DATABASE ${literal(k.database)}, USER ${literal(k.user)}, PASSWORD ${literal(password)})`
          );
          await c.run(`ATTACH '' AS ${q(alias)} (TYPE ${source.format}, SECRET ${secret}, READ_ONLY)`);
        } else throw new ConnectorError(`${source.format} is not a database`, 'invalid');
        attachedOk = true;
        return await fn(c, alias);
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        const msg = clean(e, password);
        const auth = /password|authentication|access denied/i.test(msg);
        throw new ConnectorError(auth ? `The server refused the user name or password. ${msg}` : msg, auth ? 'password' : 'failed');
      } finally {
        if (attachedOk) await c.run(`DETACH ${q(alias)}`).catch(() => undefined);
        await c.run(`DROP TEMPORARY SECRET IF EXISTS ${secret}`).catch(() => undefined);
        c.closeSync();
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** The tables and views in a database, skipping system schemas. */
  listTables(source: TableSource, password?: string): Promise<DbTable[]> {
    return this.attached(source, password, async (c, alias) => {
      const r = await c.runAndReadAll(
        `SELECT table_schema, table_name FROM information_schema.tables
         WHERE table_catalog = $1 AND table_schema NOT IN ('information_schema', 'pg_catalog', 'pg_toast', 'mysql', 'performance_schema', 'sys')
         ORDER BY 1, 2`,
        [alias]
      );
      return r.getRowsJS().map((row) => ({ schema: String(row[0]), name: String(row[1]) }));
    });
  }

  /**
   * Reads a source's rows and hands them to `consume` as a streaming result, with nested values
   * (lists, structs and the like) converted to text, as for files.
   */
  read<T>(source: TableSource, password: string | undefined, consume: (result: DuckDBResult) => Promise<T>): Promise<T> {
    return this.attached(source, password, async (c, alias) => {
      let from: string;
      let params: string[] = [];
      if (source.query !== undefined && source.format !== 'sqlite') {
        if (!source.query.trim()) throw new ConnectorError('The query is empty', 'invalid');
        from = `${source.format === 'postgres' ? 'postgres_query' : 'mysql_query'}(${literal(alias)}, $1)`;
        params = [source.query];
      } else if (source.table) {
        from = source.table.schema ? `${q(alias)}.${q(source.table.schema)}.${q(source.table.name)}` : `${q(alias)}.${q(source.table.name)}`;
      } else throw new ConnectorError('Choose a table to import', 'invalid');
      try {
        const desc = await c.runAndReadAll(`DESCRIBE SELECT * FROM ${from}`, params);
        const cols = desc.getRowsJS().map((r) => ({ name: String(r[0]), type: String(r[1]) }));
        if (!cols.length) throw new ConnectorError('The table has no columns', 'invalid');
        const select = cols.map((col) => (isScalarType(col.type) ? q(col.name) : `CAST(${q(col.name)} AS VARCHAR) AS ${q(col.name)}`)).join(', ');
        const result = await c.stream(`SELECT ${select} FROM ${from}`, params);
        return await consume(result);
      } catch (e) {
        if (e instanceof ConnectorError) throw e;
        throw new ConnectorError(clean(e, password), 'failed');
      }
    });
  }
}

/** Types that are stored as they are; nested values (lists, structs, maps, unions), JSON and BLOBs become text. */
export function isScalarType(t: string): boolean {
  const u = t.toUpperCase();
  return !(u.includes('STRUCT') || u.includes('[]') || u.startsWith('MAP') || u.startsWith('UNION') || u === 'JSON' || u.startsWith('LIST') || u === 'BLOB');
}
