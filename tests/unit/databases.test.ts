// Database imports. SQLite runs wherever the connectors were fetched (node scripts/fetch-duckdb-extensions.mjs);
// CI sets REQUIRE_DB_CONNECTORS so a missing download fails instead of skipping. PostgreSQL and MySQL run
// when ONTOLOGY_TEST_POSTGRES / ONTOLOGY_TEST_MYSQL are set, against the service containers in ci.yml.
import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONNECTORS, literal, scrub } from '../../src/main/engine/connector';
import { Engine } from '../../src/main/engine/engine';
import type { ServerConnection, TableDef, TableSource } from '@shared/types';

const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as string];
const extDir = resolve(__dirname, '..', '..', 'build', 'duckdb-extensions', `${os}-${process.arch}`);
const available = CONNECTORS.every((n) => existsSync(join(extDir, `${n}.duckdb_extension`)));
if (!available && process.env['REQUIRE_DB_CONNECTORS']) throw new Error(`Database connectors are missing from ${extDir}`);

describe('connection settings in SQL', () => {
  it('escapes quotes in literals and refuses NUL', () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(literal("x'); DROP TABLE t; --")).toBe("'x''); DROP TABLE t; --'");
    expect(() => literal('a\0b')).toThrow(/NUL/);
  });
  it('scrubs a password from messages', () => {
    expect(scrub('failed for p@ss and p@ss', 'p@ss')).toBe('failed for •••• and ••••');
    expect(scrub('nothing here', undefined)).toBe('nothing here');
  });
});

describe.skipIf(!available)('databases', () => {
  let engine: Engine;
  let dir: string;
  let n = 0;

  /** Runs setup SQL in a separate, writable DuckDB with the connectors loaded. */
  async function setup(statements: string[]): Promise<void> {
    const db = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' });
    const c = await db.connect();
    for (const name of CONNECTORS) await c.run(`LOAD ${literal(join(extDir, `${name}.duckdb_extension`))}`);
    for (const s of statements) await c.run(s);
    c.closeSync();
  }

  async function rows(id: string, source: TableSource, r: { columns: TableDef['columns']; rowCount: number }): Promise<unknown[][]> {
    const p = await engine.preview({ id, name: id, source, columns: r.columns, rowCount: r.rowCount }, 100, 0);
    return p.rows;
  }

  beforeAll(async () => {
    engine = await Engine.create({ extensionsDir: extDir });
    dir = mkdtempSync(join(tmpdir(), 'ontology-db-'));
    const file = join(dir, 'shop.db').replace(/\\/g, '/');
    await setup([
      `ATTACH ${literal(file)} AS shop (TYPE sqlite)`,
      "CREATE TABLE shop.orders AS SELECT * FROM (VALUES (1, 'Pen', 2.5), (2, 'Ink', 4.0), (3, 'Pad', NULL)) t(id, item, price)",
      "CREATE TABLE shop.customers AS SELECT 7 AS id, 'Ann' AS name",
      'DETACH shop'
    ]);
  });
  afterAll(() => engine.close());

  it('lists the tables in a SQLite file and imports one, with cleaning steps', async () => {
    const source: TableSource = { path: join(dir, 'shop.db'), format: 'sqlite' };
    expect(await engine.listDbTables(source)).toEqual([
      { schema: 'main', name: 'customers' },
      { schema: 'main', name: 'orders' }
    ]);
    const src: TableSource = { ...source, table: { schema: 'main', name: 'orders' } };
    const r = await engine.importTable('sq', src, [{ id: 's1', kind: 'filter', column: 'item', op: '!=', value: 'Ink' }]);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'item', 'price']);
    expect(r.rowCount).toBe(2);
    expect((await rows('sq', src, r)).map((x) => x[1])).toEqual(['Pen', 'Pad']);
  });

  it('refuses files that are not SQLite databases by extension, and reports missing files', async () => {
    await expect(engine.listDbTables({ path: join(dir, 'shop.csv'), format: 'sqlite' })).rejects.toThrow(/does not look like a SQLITE file/);
    await expect(engine.importTable('x', { path: join(dir, 'gone.db'), format: 'sqlite', table: { name: 'orders' } })).rejects.toMatchObject({
      code: 'missing'
    });
  });

  it('asks for a password before connecting to a server', async () => {
    const connection: ServerConnection = { id: 'c1', host: '127.0.0.1', port: 1, database: 'x', user: 'y' };
    await expect(engine.listDbTables({ path: 'postgres://y@127.0.0.1:1/x', format: 'postgres', connection })).rejects.toMatchObject({ code: 'password' });
  });

  const servers = [
    {
      format: 'postgres' as const,
      env: 'ONTOLOGY_TEST_POSTGRES',
      connection: { id: 'pg', host: '127.0.0.1', port: 5432, database: 'postgres', user: 'postgres' },
      password: 'postgres',
      schema: 'public'
    },
    {
      format: 'mysql' as const,
      env: 'ONTOLOGY_TEST_MYSQL',
      connection: { id: 'my', host: '127.0.0.1', port: 3306, database: 'shop', user: 'root' },
      password: 'root',
      schema: 'shop'
    }
  ];

  for (const s of servers) {
    describe.skipIf(!process.env[s.env])(s.format, () => {
      const source: TableSource = { path: `${s.format}://${s.connection.user}@host/db`, format: s.format, connection: s.connection };

      beforeAll(async () => {
        const k = s.connection;
        await setup([
          `CREATE SECRET w (TYPE ${s.format}, HOST '${k.host}', PORT ${k.port}, DATABASE '${k.database}', USER '${k.user}', PASSWORD '${s.password}')`,
          `ATTACH '' AS w (TYPE ${s.format}, SECRET w)`,
          `CREATE OR REPLACE TABLE w.${s.schema}.sales AS SELECT * FROM (VALUES (1, 'East', 100), (2, 'West', 250)) t(id, region, amount)`,
          'DETACH w'
        ]);
      });

      it('lists tables, imports a table and runs a query', async () => {
        expect(await engine.listDbTables(source, s.password)).toContainEqual({ schema: s.schema, name: 'sales' });
        const t = await engine.importTable(`${s.format}_t${++n}`, { ...source, table: { schema: s.schema, name: 'sales' } }, [], s.password);
        expect(t.rowCount).toBe(2);
        const q = await engine.importTable(
          `${s.format}_q${++n}`,
          { ...source, query: 'SELECT region, amount * 2 AS doubled FROM sales WHERE amount > 150' },
          [],
          s.password
        );
        expect(q.columns.map((c) => c.name)).toEqual(['region', 'doubled']);
        expect(q.rowCount).toBe(1);
      });

      it('reports a wrong password without repeating it', async () => {
        const wrong = 'Wr0ng-Pa55word';
        const err = await engine.listDbTables(source, wrong).catch((e: Error & { code?: string }) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe('password');
        expect((err as Error).message).not.toContain(wrong);
      });
    });
  }
});
