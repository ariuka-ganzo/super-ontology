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

test('table calculations can run along a chosen dimension', async () => {
  const { page } = l;
  await page.getByRole('button', { name: '+ New calculation' }).click();
  await page.getByLabel('Calculation name').fill('Share');
  await page.getByLabel('Formula').fill('PERCENT_OF_TOTAL(SUM([amount]))');
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click();
  // The control only appears once the view has a table calculation and two dimensions.
  await page.getByTestId('field-sale_date').dblclick();
  await page.getByTestId('field-Share').dblclick();
  await expect(page.getByLabel('Table calculations run along')).toHaveCount(0);
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('chart-table').click();
  const box = page.getByTestId('chart-box');
  const along = page.getByLabel('Table calculations run along');
  await expect(along).toBeVisible();
  const share = async (month: string, region: string): Promise<string | undefined> =>
    (await tableRows(box)).find((r) => r.includes(month) && r.includes(region))?.at(-1);

  // Automatic runs along the month: East's January sales (300) are part of East's 550 across months.
  await expect.poll(() => share('Jan 2024', 'East')).not.toBe(await share('Feb 2024', 'West'));
  // Along region: each month's regions add up to 100%, so January East and February West are both the whole month.
  await along.selectOption({ label: 'region' });
  await expect.poll(async () => (await share('Jan 2024', 'East')) === (await share('Feb 2024', 'West'))).toBe(true);
  await expect.poll(() => share('Mar 2024', 'East')).not.toBe(await share('Jan 2024', 'East'));
});

test('every chart type renders, and sorting works', async () => {
  const { page } = l;
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('field-amount').dblclick();
  await page.getByTestId('field-units').dblclick();
  const box = page.getByTestId('chart-box');
  // Two measures and one dimension: scatter is recommended.
  await expect(page.getByTestId('recommendation')).toContainText('Scatter');
  await expect(box.locator('svg path:not([fill="none"])').first()).toBeVisible();

  // Remove units, then try each chart type with one dimension and one measure,
  // and with a second dimension on Color where the chart needs two.
  await page.getByTestId('shelf-rows').getByTestId('pill').filter({ hasText: 'units' }).getByLabel('Field options').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  for (const type of ['bar', 'line', 'area', 'pie', 'donut', 'table', 'pivot']) {
    await page.getByTestId(`chart-${type}`).click();
    await expect(box).toHaveAttribute('data-chart-type', type);
    await expect(page.getByTestId('view-error')).toHaveCount(0);
    // A pivot spreads the dimension on Columns across one row.
    if (type === 'table' || type === 'pivot') await expect(box.locator('table.result tbody tr')).toHaveCount(type === 'table' ? 3 : 1);
    else await expect(box.locator('svg path:not([fill="none"])').first()).toBeVisible();
  }
  await page.getByTestId('field-rep_id').dblclick();
  for (const type of ['stackedBar', 'heatmap']) {
    await page.getByTestId(`chart-${type}`).click();
    await expect(box).toHaveAttribute('data-chart-type', type);
    await expect(box.locator('svg path:not([fill="none"])').first()).toBeVisible();
  }
  await page.getByTestId('shelf-color').getByTestId('pill').getByLabel('Field options').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await page.getByTestId('chart-kpi').click();
  await expect(page.getByText('does not suit these fields')).toBeVisible();
  await page.getByTestId('shelf-columns').getByTestId('pill').getByLabel('Field options').click();
  await page.getByRole('menuitem', { name: 'Remove' }).click();
  await expect(page.locator('.kpi .value')).toHaveText('1,050');

  // Sort descending by the measure.
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('chart-table').click();
  await page.getByRole('button', { name: /^Sort/ }).click();
  await expect
    .poll(() => tableRows(box))
    .toEqual([
      ['East', '550'],
      ['North', '300'],
      ['West', '200']
    ]);
  await page.getByRole('button', { name: /^Sort/ }).click();
  await expect
    .poll(() => tableRows(box))
    .toEqual([
      ['West', '200'],
      ['North', '300'],
      ['East', '550']
    ]);
  await shot(page, 'worksheet-sorted');
});
