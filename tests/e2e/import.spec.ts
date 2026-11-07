import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import writeXlsxFile from 'write-excel-file/node';
import { importFixtures, launch, shot, stubDialogs, tempDir, type Launched } from './helpers';

let l: Launched;
test.beforeEach(async () => {
  l = await launch({ firstRun: false });
});
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

test('imports CSV, shows a preview, types and a column profile', async () => {
  const { page } = l;
  await expect(page.getByText('Bring in some data')).toBeVisible();
  await importFixtures(l, ['sales.csv']);
  await expect(page.getByText('6 rows', { exact: true })).toBeVisible();
  const grid = page.getByTestId('data-grid');
  await expect(grid.locator('tbody tr')).toHaveCount(6);
  await expect(grid.locator('tbody tr').first()).toContainText('East');
  await expect(page.getByLabel('Type of sale_date')).toHaveValue('date');
  await expect(page.getByLabel('Type of amount')).toHaveValue('integer');

  // Column profile.
  await grid.getByText('amount', { exact: true }).click();
  const profile = page.getByTestId('profile');
  await expect(profile).toContainText('Distinct');
  await expect(profile.locator('dd').nth(2)).toHaveText('6');
  await expect(profile.locator('dd').nth(3)).toHaveText('50');
  await expect(profile.locator('dd').nth(4)).toHaveText('300');

  // Manual type override.
  await page.getByLabel('Type of rep_id').selectOption('string');
  await grid.getByText('rep_id', { exact: true }).click();
  await expect(profile).toContainText('Most common values');
  await shot(page, 'import-data-view');
});

test('imports Excel and reports a missing file clearly on reload', async () => {
  const { page, app } = l;
  const dir = tempDir();
  const xlsx = join(dir, 'targets.xlsx');
  await writeXlsxFile([
    ['region', 'target'],
    ['East', 500],
    ['West', 400]
  ]).toFile(xlsx);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await stubDialogs(app, { open: [xlsx] });
  await page.locator('.topbar').getByRole('button', { name: 'Import data…' }).click();
  await expect(page.getByText('2 rows', { exact: true })).toBeVisible();
  await expect(page.getByTestId('data-grid')).toContainText('West');

  // Reload after the file is gone.
  const { rmSync } = await import('node:fs');
  rmSync(xlsx);
  await page.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByTestId('toast-error')).toContainText('was not found');
  await expect(page.getByRole('button', { name: 'Locate file…' }).first()).toBeVisible();
});
