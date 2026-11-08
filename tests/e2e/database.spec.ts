import { expect, test } from '@playwright/test';
import { DuckDBInstance } from '@duckdb/node-api';
import { join } from 'node:path';
import { ROOT, launch, shot, stubDialogs, tempDir, type Launched } from './helpers';

const CONNECTORS = ['sqlite_scanner', 'postgres_scanner', 'mysql_scanner'];
const os = { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform as string];
const extDir = join(ROOT, 'build', 'duckdb-extensions', `${os}-${process.arch}`);
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

let l: Launched;
test.beforeEach(async () => {
  l = await launch({ firstRun: false });
});
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

/** Writes a SQLite database with two tables, using DuckDB's SQLite connector. */
async function makeSqlite(file: string): Promise<void> {
  const db = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false', autoload_known_extensions: 'false' });
  const c = await db.connect();
  for (const n of CONNECTORS) await c.run(`LOAD ${lit(join(extDir, `${n}.duckdb_extension`))}`);
  await c.run(`ATTACH ${lit(file.replace(/\\/g, '/'))} AS s (TYPE sqlite)`);
  await c.run("CREATE TABLE s.orders AS SELECT * FROM (VALUES (1, 'East', 100), (2, 'West', 250), (3, 'East', 50)) t(id, region, amount)");
  await c.run("CREATE TABLE s.notes AS SELECT 'hello' AS text");
  await c.run('DETACH s');
  c.closeSync();
}

test('imports tables from a SQLite file and reloads them', async () => {
  const { page, app } = l;
  const file = join(tempDir(), 'shop.db');
  await makeSqlite(file);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await stubDialogs(app, { open: [file] });
  await page.locator('.topbar').getByRole('button', { name: 'Import data…' }).click();

  const picker = page.getByTestId('sheet-picker');
  await expect(picker).toContainText('shop.db has 2 tables');
  await picker.getByLabel('orders').check();
  await picker.getByLabel('notes').uncheck();
  await page.getByRole('dialog').getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Imported orders: 3 rows' })).toBeVisible();
  await expect(page.getByText('shop.db · orders')).toBeVisible();

  // Cleaning steps and Reload work as for files.
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Reloaded orders: 3 rows' })).toBeVisible();
  await page.getByText('Sheet 1').click();
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('field-amount').dblclick();
  await page.getByTestId('chart-table').click();
  await expect(page.getByTestId('chart-box').locator('table.result tbody tr')).toHaveCount(2);
});

test('the database dialog explains a connection that fails, without showing the password', async () => {
  const { page } = l;
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('button', { name: 'Connect to a database…' }).click();
  const d = page.getByTestId('database-dialog');
  await expect(d.getByLabel('Port')).toHaveValue('5432');
  await d.getByLabel('Database type').selectOption('mysql');
  await expect(d.getByLabel('Port')).toHaveValue('3306');
  await d.getByLabel('Database type').selectOption('postgres');
  // Port 1 on this machine refuses connections straight away.
  await d.getByLabel('Server').fill('127.0.0.1');
  await d.getByLabel('Port').fill('1');
  await d.getByLabel('Database', { exact: true }).fill('shop');
  await d.getByLabel('User name').fill('reader');
  await d.getByLabel('Password', { exact: true }).fill('Very-Secret-123');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  const err = page.getByTestId('database-error');
  await expect(err).toBeVisible({ timeout: 30_000 });
  await expect(err).not.toContainText('Very-Secret-123');
  await shot(page, 'database-dialog-error');
});
