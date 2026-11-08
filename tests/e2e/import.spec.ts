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

test('asks which sheets of a workbook to import, and keeps the sheet when the file moves', async () => {
  const { page, app } = l;
  const dir = tempDir();
  const sheets = [
    {
      sheet: 'North',
      data: [
        ['region', 'target'],
        ['North', 100]
      ]
    },
    {
      sheet: 'South',
      data: [
        ['region', 'target'],
        ['South', 200],
        ['South', 300]
      ]
    },
    { sheet: 'Notes', data: [['text'], ['ignore me']] }
  ];
  const xlsx = join(dir, 'regions.xlsx');
  await writeXlsxFile(sheets.map((s) => ({ sheet: s.sheet, data: s.data }))).toFile(xlsx);
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await stubDialogs(app, { open: [xlsx] });
  await page.locator('.topbar').getByRole('button', { name: 'Import data…' }).click();

  // The first sheet is chosen by default; add the second one.
  const picker = page.getByTestId('sheet-picker');
  await expect(picker).toContainText('regions.xlsx has 3 sheets');
  await expect(picker.getByLabel('North')).toBeChecked();
  await picker.getByLabel('South').check();
  await page.getByRole('button', { name: 'Import 2 sheets' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Imported regions (North): 1 rows' })).toBeVisible();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Imported regions (South): 2 rows' })).toBeVisible();
  await expect(page.getByText('sheet South')).toBeVisible();

  // Point the South table at a copy of the workbook in which South is now the last sheet: no question is asked.
  const moved = join(dir, 'moved.xlsx');
  await writeXlsxFile([
    sheets[2],
    sheets[0],
    {
      sheet: 'South',
      data: [
        ['region', 'target'],
        ['South', 1],
        ['South', 2],
        ['South', 3]
      ]
    }
  ]).toFile(moved);
  await stubDialogs(app, { open: [moved] });
  await page.getByRole('button', { name: 'Locate file…' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Reloaded regions (South): 3 rows' })).toBeVisible();
  await expect(page.getByTestId('sheet-picker')).toHaveCount(0);

  // Cancelling the picker imports nothing.
  await stubDialogs(app, { open: [xlsx] });
  await page.locator('.topbar').getByRole('button', { name: 'Import data…' }).click();
  await page.getByRole('dialog', { name: 'Choose sheets to import' }).getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('sheet-picker')).toHaveCount(0);
  await expect(page.getByTestId('nav-data')).toContainText('2');
});
