import { expect, test } from '@playwright/test';
import { launch, shot, type Launched } from './helpers';

let l: Launched;
test.beforeEach(async () => {
  // The sample project opens on first launch.
  l = await launch();
});
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

test('explores the sample: suggests a graph, ranks insights, explains a value, and follows the timeline', async () => {
  const { page } = l;
  await expect(page.getByTestId('dashboard-canvas')).toBeVisible();
  const started = Date.now();
  await page.getByTestId('nav-explore').click();

  // A suggested exploration builds on its own.
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('data-settled', 'true', { timeout: 20_000 });
  const firstGraphMs = Date.now() - started;
  expect(Number(await canvas.getAttribute('data-nodes'))).toBeGreaterThan(10);
  expect(Number(await canvas.getAttribute('data-edges'))).toBeGreaterThan(5);
  await expect(page.getByTestId('explore-fields').locator('.pill')).not.toHaveCount(0);
  await expect(page.getByTestId('graph-unavailable')).toHaveCount(0);

  // Ranked, explained insights.
  const insights = page.getByTestId('insight');
  await expect(insights.first()).toBeVisible();
  expect(await insights.count()).toBeGreaterThan(3);
  await expect(insights.first().locator('.insight-detail')).not.toBeEmpty();
  await shot(page, 'explore-overview');

  // Clicking an insight highlights it; clicking again clears it.
  await insights.first().click();
  await expect(insights.first()).toHaveClass(/active/);
  await insights.first().click();
  await expect(insights.first()).not.toHaveClass(/active/);

  // Find a value and read its story.
  const firstLabel = (await page.getByTestId('explore-fields').locator('.pill-text').first().textContent()) ?? '';
  expect(firstLabel).not.toBe('');
  await page.getByLabel('Find a value').fill('a');
  await page.getByTestId('search-results').getByRole('button').first().click();
  await expect(page.getByTestId('node-panel')).toBeVisible();
  await expect(page.getByTestId('node-amount')).not.toBeEmpty();
  await expect(page.getByTestId('drivers')).toContainText('What makes it different');
  await shot(page, 'explore-node');

  // Move the time window: the graph follows quickly and keeps its nodes.
  const nodesBefore = await canvas.getAttribute('data-nodes');
  const status = page.getByTestId('explore-status');
  await page.getByRole('button', { name: 'All time' }).click();
  await expect(page.getByTestId('timeline-window')).toContainText('all time');
  await expect(status).not.toContainText('Updating');
  const ms = Number((await status.textContent())?.match(/(\d+) ms/)?.[1]);
  expect(ms).toBeLessThan(3000);
  expect(await canvas.getAttribute('data-nodes')).toBe(nodesBefore);
  await page.getByRole('button', { name: 'Latest' }).click();
  await expect(page.getByTestId('timeline-window')).toContainText('compared with');

  // Colour by change, and send a value to a worksheet.
  await page.getByRole('button', { name: 'Colour: change' }).click();
  await shot(page, 'explore-change');
  await page.getByRole('button', { name: 'Open in worksheet' }).click();
  await expect(page.getByTestId('chart-box')).toBeVisible();
  await expect(page.getByTestId('view-error')).toHaveCount(0);

  console.log(`Explore on the sample: first graph in ${firstGraphMs} ms, window change ${ms} ms`);
});
