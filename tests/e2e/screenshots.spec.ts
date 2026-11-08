import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import { launch, ROOT } from './helpers';

// Captures the README screenshots from the real app. Run with ONTOLOGY_SCREENSHOTS=1.
test.skip(!process.env['ONTOLOGY_SCREENSHOTS'], 'set ONTOLOGY_SCREENSHOTS=1 to capture README screenshots');

const out = (name: string): string => join(ROOT, 'docs', 'screenshots', `${name}.png`);

test('README screenshots', async () => {
  const { page, app } = await launch();
  const settle = (): Promise<void> => page.waitForTimeout(1500);
  await expect(page.getByTestId('dashboard-canvas')).toBeVisible();
  await settle();
  await page.screenshot({ path: out('dashboard') });

  await page.locator('nav').getByText('Sales by category').click();
  await settle();
  await page.screenshot({ path: out('worksheet') });

  await page.getByTestId('nav-data').click();
  await page.getByTestId('data-grid').getByText('sales', { exact: true }).click();
  await settle();
  await page.screenshot({ path: out('data') });

  await page.getByTestId('nav-model').click();
  await page.getByRole('button', { name: 'Edit' }).nth(1).click();
  await settle();
  await page.screenshot({ path: out('formula') });
  await page.keyboard.press('Escape');

  await page.getByLabel('Toggle theme').click();
  await page.getByText('Sales overview').click();
  await page.locator('[data-title="Sales by segment"] svg path').first().waitFor();
  await page.locator('[data-title="Sales by category"] svg path[fill="#5b93f5"]').first().click();
  await page.locator('.view-body').evaluate((el) => el.scrollTo(0, 0));
  await settle();
  await page.screenshot({ path: out('dashboard-dark-crossfilter') });
  await app.close();
});
