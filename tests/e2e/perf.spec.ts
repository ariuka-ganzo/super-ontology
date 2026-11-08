import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launch, ROOT, shot, stubDialogs, tempDir } from './helpers';

// Measures the v0.1 target: a 1 million row CSV imported and charted in under 5 seconds.
// Run with ONTOLOGY_PERF=1. Not part of the normal test run because it writes a 50 MB file.
test.skip(!process.env['ONTOLOGY_PERF'], 'set ONTOLOGY_PERF=1 to run the performance test');

test('1 million row CSV: import and first chart', async () => {
  const csv = join(tempDir(), 'one-million.csv');
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'generate-large-csv.mjs'), csv, '1000000']);
  const mb = (statSync(csv).size / 1e6).toFixed(1);
  expect(existsSync(csv)).toBe(true);

  const l = await launch({ firstRun: false });
  const { page, app } = l;
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await stubDialogs(app, { open: [csv] });

  const t0 = Date.now();
  await page.locator('.topbar').getByRole('button', { name: 'Import data…' }).click();
  const toast = page.getByTestId('toast-info').filter({ hasText: 'Imported one-million' });
  await expect(toast).toBeVisible({ timeout: 60_000 });
  const tImported = Date.now();
  const engineImport = (await toast.textContent())?.match(/in ([\d.]+) s/)?.[1];

  await page.getByText('Sheet 1').click();
  const tSheet = Date.now();
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('field-sales').dblclick();
  await expect(page.getByTestId('chart-box').locator('svg path[fill="#2f6fdf"]')).toHaveCount(5, { timeout: 60_000 });
  const tChart = Date.now();
  await shot(page, 'perf-1m');

  const result = {
    file: `${mb} MB, 1,000,000 rows`,
    importClickToReadyMs: tImported - t0,
    engineImportSeconds: engineImport,
    firstChartFromFieldsMs: tChart - tSheet,
    totalMs: tImported - t0 + (tChart - tSheet)
  };
  console.log('PERF', JSON.stringify(result));
  await app.close();
  expect(result.totalMs).toBeLessThan(5000);
});
