import { expect, test, type Page } from '@playwright/test';
import { importFixtures, launch, shot, tableRows, type Launched } from './helpers';

let l: Launched;
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

async function sheet(page: Page, name: string, fields: string[], chart: string): Promise<void> {
  await page.getByTestId('add-worksheet').click();
  await page.getByLabel('Worksheet name').fill(name);
  await page.getByLabel('Worksheet name').press('Tab');
  for (const f of fields) await page.getByTestId(`field-${f}`).first().dblclick();
  await page.getByTestId(`chart-${chart}`).click();
}

test('builds a dashboard and cross-filters it by clicking a bar', async () => {
  l = await launch({ firstRun: false });
  const { page } = l;
  await importFixtures(l, ['sales.csv', 'reps.csv']);

  // Relationship from the suggestion list.
  await page.getByTestId('nav-model').click();
  await page.getByTestId('suggestion').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('relationship')).toContainText('Many to one');

  await sheet(page, 'By region', ['region', 'amount'], 'bar');
  await sheet(page, 'By team', ['team', 'amount'], 'table');

  await page.getByText('Dashboard 1').click();
  for (const name of ['By region', 'By team']) {
    await page.getByRole('button', { name: '+ Add tile' }).click();
    await page.getByRole('menuitem', { name: `Worksheet: ${name}` }).click();
  }
  await page.getByRole('button', { name: '+ Add tile' }).click();
  await page.getByRole('menuitem', { name: 'Slicer…' }).click();
  await page.getByLabel('Slicer field').selectOption({ label: 'reps.team' });
  await page.getByRole('button', { name: 'Add slicer' }).click();

  const team = page.locator('[data-testid="tile-worksheet"][data-title="By team"]');
  const region = page.locator('[data-testid="tile-worksheet"][data-title="By region"]');
  await expect
    .poll(() => tableRows(team))
    .toEqual([
      ['Blue', '550'],
      ['Red', '500']
    ]);
  await shot(page, 'dashboard-built');

  // Click the North bar (the second of three, sorted by region): North is only Di on the Red team.
  const bars = region.locator('svg path[fill="#2f6fdf"]');
  await expect(bars).toHaveCount(3);
  await bars.nth(1).click();
  await expect(page.getByTestId('crossfilter-chip')).toContainText('Filtered by North');
  await expect.poll(() => tableRows(team)).toEqual([['Red', '300']]);
  await shot(page, 'dashboard-crossfiltered');

  // Clear it with the visible control.
  await page.getByRole('button', { name: 'Clear cross-filter' }).click();
  await expect(page.getByTestId('crossfilter-chip')).toHaveCount(0);
  await expect
    .poll(() => tableRows(team))
    .toEqual([
      ['Blue', '550'],
      ['Red', '500']
    ]);

  // Clicking a table row cross-filters the bar chart the other way.
  await team.locator('table.result tbody tr').first().click();
  await expect(page.getByTestId('crossfilter-chip')).toContainText('Filtered by Blue');
  await expect(region.locator('svg path[fill="#2f6fdf"]')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear cross-filter' }).click();

  // The slicer filters both tiles.
  await page.getByTestId('slicer-list').getByText('Red').click();
  await expect.poll(() => tableRows(team)).toEqual([['Red', '500']]);
  await expect(region.locator('svg path[fill="#2f6fdf"]')).toHaveCount(2);

  // Dark theme renders too.
  await page.getByLabel('Toggle theme').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await shot(page, 'dashboard-dark');
});

test('first launch opens the sample project and its dashboard renders', async () => {
  l = await launch();
  const { page } = l;
  await expect(page.getByRole('textbox', { name: 'Project name' })).toHaveValue('Sample: Harbor & Pine sales');
  await expect(page.getByTestId('dashboard-canvas')).toBeVisible();
  await expect(page.locator('.kpi .value').first()).toHaveText(/^\$[\d,]+$/);
  await expect(page.locator('[data-testid="chart-box"]')).toHaveCount(4);
  await expect(page.getByTestId('view-error')).toHaveCount(0);
  await shot(page, 'sample-overview');
  await page.getByRole('button', { name: 'Customers', exact: true }).click();
  await expect(page.locator('[data-title="Top 10 customers"] table.result tbody tr')).toHaveCount(10);
  await expect(page.getByTestId('view-error')).toHaveCount(0);
  await shot(page, 'sample-customers');
});

test('date range slicer filters the page', async () => {
  l = await launch({ firstRun: false });
  const { page } = l;
  await importFixtures(l, ['sales.csv']);
  await page.getByText('Sheet 1').click();
  await page.getByTestId('field-region').dblclick();
  await page.getByTestId('field-amount').dblclick();
  await page.getByTestId('chart-table').click();
  await page.getByText('Dashboard 1').click();
  await page.getByRole('button', { name: '+ Add tile' }).click();
  await page.getByRole('menuitem', { name: 'Worksheet: Sheet 1' }).click();
  await page.getByRole('button', { name: '+ Add tile' }).click();
  await page.getByRole('menuitem', { name: 'Slicer…' }).click();
  await page.getByLabel('Slicer field').selectOption({ label: 'sales.sale_date' });
  await expect(page.getByLabel('Slicer type')).toHaveValue('dateRange');
  await page.getByRole('button', { name: 'Add slicer' }).click();
  const slicer = page.getByTestId('slicer-dateRange');
  await expect(slicer).toContainText('2024-01-10 to 2024-03-12');
  await slicer.getByLabel('From').fill('2024-02-01');
  await slicer.getByLabel('To').fill('2024-02-29');
  const tile = page.locator('[data-testid="tile-worksheet"][data-title="Sheet 1"]');
  // February: West 50 + 150.
  await expect.poll(() => tableRows(tile)).toEqual([['West', '200']]);
  await slicer.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(() => tableRows(tile)).toHaveLength(3);
});

test('slicers narrow the values offered by the other slicers on the page', async () => {
  l = await launch({ firstRun: false });
  const { page } = l;
  await importFixtures(l, ['sales.csv']);
  await page.getByText('Dashboard 1').click();
  for (const [field, type] of [
    ['sales.sale_date', 'dateRange'],
    ['sales.region', 'list']
  ]) {
    await page.getByRole('button', { name: '+ Add tile' }).click();
    await page.getByRole('menuitem', { name: 'Slicer…' }).click();
    await page.getByLabel('Slicer field').selectOption({ label: field });
    await expect(page.getByLabel('Slicer type')).toHaveValue(type);
    await page.getByRole('button', { name: 'Add slicer' }).click();
  }
  const dates = page.getByTestId('slicer-dateRange');
  const regions = page.getByTestId('slicer-list');
  const options = (): Promise<string[]> => regions.locator('.opt').allTextContents();
  await expect.poll(options).toEqual(['East', 'North', 'West']);

  // Pick East, then narrow the dates to February, when only West sold: East stays listed so it can be cleared.
  await regions.getByText('East').click();
  await dates.getByLabel('From').fill('2024-02-01');
  await dates.getByLabel('To').fill('2024-02-29');
  await expect.poll(options).toEqual(['West', 'East (no data)']);
  // The region slicer's own choice does not narrow its own list, but it narrows the date range shown.
  await regions.getByRole('button', { name: 'Clear' }).click();
  await expect.poll(options).toEqual(['West']);
  await dates.getByRole('button', { name: 'Clear' }).click();
  await regions.getByText('North').click();
  await expect(dates).toContainText('2024-03-01 to 2024-03-01');
  await expect.poll(options).toEqual(['East', 'North', 'West']);
});
