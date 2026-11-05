import { expect, test } from '@playwright/test';
import { drag, importFixtures, launch, shot, tableRows, type Launched } from './helpers';

let l: Launched;
test.beforeEach(async () => {
  l = await launch({ firstRun: false });
  await importFixtures(l, ['sales.csv']);
  await l.page.getByText('Sheet 1').click();
});
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

test('builds a bar chart by dragging fields, then checks the numbers', async () => {
  const { page } = l;
  await drag(page, page.getByTestId('field-region'), page.getByTestId('shelf-columns'));
  await expect(page.getByTestId('shelf-columns').getByTestId('pill')).toHaveText(/region/);
  await drag(page, page.getByTestId('field-amount'), page.getByTestId('shelf-rows'));
  await expect(page.getByTestId('shelf-rows').getByTestId('pill')).toHaveText(/Sum of amount/);

  // Automatic chart type picks the recommended bar chart.
  await expect(page.getByTestId('recommendation')).toContainText('Bar');
  const box = page.getByTestId('chart-box');
  await expect(box).toHaveAttribute('data-chart-type', 'bar');
  await expect(box.locator('svg')).toBeVisible();
  // Three bars, one per region.
  await expect(box.locator('svg path[fill="#2f6fdf"]')).toHaveCount(3);
  await shot(page, 'worksheet-bar');

  // The same view as a table shows the hand-calculated sums.
  await page.getByTestId('chart-table').click();
  await expect
    .poll(() => tableRows(box))
    .toEqual([
      ['East', '550'],
      ['North', '300'],
      ['West', '200']
    ]);

  // Undo goes back to the bar chart, redo returns to the table.
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(box).toHaveAttribute('data-chart-type', 'bar');
  await page.getByRole('button', { name: /Redo/ }).click();
  await expect(box).toHaveAttribute('data-chart-type', 'table');
});

test('date drill, sort, filter and a calculated field', async () => {
  const { page } = l;
  await page.getByTestId('field-sale_date').dblclick();
  await page.getByTestId('field-amount').dblclick();
  const box = page.getByTestId('chart-box');
  await expect(box).toHaveAttribute('data-chart-type', 'line');
  await page.getByTestId('chart-table').click();
  // Month level by default: Jan 300, Feb 200, Mar 550.
  await expect
    .poll(() => tableRows(box))
    .toEqual([
      ['Jan 2024', '300'],
      ['Feb 2024', '200'],
      ['Mar 2024', '550']
    ]);
  // Drill up to quarter.
  await page.getByTestId('shelf-columns').getByTitle('Drill up').click();
  await expect.poll(() => tableRows(box)).toEqual([['2024 Q1', '1,050']]);

  // Calculated field with an error, then fixed.
  await page.getByRole('button', { name: '+ New calculation' }).click();
  await page.getByLabel('Calculation name').fill('Avg price');
  await page.getByLabel('Formula').fill('SUM([amount]) / SUM([unitz])');
  await expect(page.getByTestId('formula-error')).toContainText('Line 1, column 21: Unknown field [unitz]. Did you mean [units]?');
  await page.getByLabel('Formula').fill('SUM([amount]) / SUM([units])');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByTestId('field-Avg price').dblclick();
  // Q1: 1050 / 13 units.
  await expect.poll(() => tableRows(box)).toEqual([['2024 Q1', '1,050', '80.77']]);

  // Filter by region through the filter dialog.
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('chart-table').click();
  await drag(page, page.getByTestId('field-region'), page.getByTestId('shelf-filters'));
  await page.getByRole('dialog').getByText('West').click();
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.getByTestId('filter-pill')).toContainText('region: West');
  await expect.poll(() => tableRows(box)).toEqual([['2024 Q1', 'West', '200', '50']]);
  await shot(page, 'worksheet-filtered');
});
