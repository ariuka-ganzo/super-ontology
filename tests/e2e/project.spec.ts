import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFixtures, launch, shot, stubDialogs, tableRows, tempDir, type Launched } from './helpers';

let l: Launched;
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

test('saves a project, reopens it and gets the same view back', async () => {
  l = await launch({ firstRun: false });
  const { page, app } = l;
  await importFixtures(l, ['sales.csv']);
  await page.getByText('Sheet 1').click();
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('field-units').dblclick();
  await page.getByTestId('chart-table').click();
  const box = page.getByTestId('chart-box');
  await expect
    .poll(() => tableRows(box))
    .toEqual([
      ['East', '8'],
      ['North', '1'],
      ['West', '4']
    ]);

  const dir = tempDir();
  const file = join(dir, 'my project.facet');
  await stubDialogs(app, { save: file });
  await page.getByRole('button', { name: 'Save as…' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Saved' })).toBeVisible();
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  expect(saved.formatVersion).toBe(1);
  expect(saved.worksheets[0].spec.chartType).toBe('table');
  expect(readFileSync(file, 'utf8')).toContain('\n  "model": {');

  // Start fresh, then open the saved file.
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Untitled');
  await stubDialogs(app, { open: [file] });
  await page.getByRole('button', { name: 'Open…' }).click();
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('sales');
  await page.getByText('Sheet 1').click();
  await expect
    .poll(() => tableRows(page.getByTestId('chart-box')))
    .toEqual([
      ['East', '8'],
      ['North', '1'],
      ['West', '4']
    ]);
  await shot(page, 'project-reopened');
});

test('exports chart PNG, data CSV and dashboard PDF', async () => {
  l = await launch();
  const { page, app } = l;
  const dir = tempDir();
  await expect(page.getByTestId('dashboard-canvas')).toBeVisible();

  await stubDialogs(app, { save: join(dir, 'page.pdf') });
  await page.getByRole('button', { name: 'Export PDF' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'page.pdf' })).toBeVisible();
  expect(readFileSync(join(dir, 'page.pdf')).subarray(0, 5).toString()).toBe('%PDF-');

  await page.locator('nav').getByText('Sales by category').click();
  await expect(page.getByTestId('chart-box').locator('svg')).toBeVisible();
  await stubDialogs(app, { save: join(dir, 'chart.png') });
  await page.getByRole('button', { name: 'Export PNG' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'chart.png' })).toBeVisible();
  expect(readFileSync(join(dir, 'chart.png')).subarray(1, 4).toString()).toBe('PNG');

  await stubDialogs(app, { save: join(dir, 'data.csv') });
  await page.getByRole('button', { name: 'Export CSV' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'data.csv' })).toBeVisible();
  const csv = readFileSync(join(dir, 'data.csv'), 'utf8');
  expect(csv.split('\r\n')[0]).toBe('\ufeffcategory,Sum of sales,segment');
  expect(csv.trim().split('\r\n')).toHaveLength(1 + 4 * 3);
});
