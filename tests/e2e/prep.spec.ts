import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importFixtures, launch, shot, stubDialogs, tempDir, type Launched } from './helpers';

let l: Launched;
test.beforeEach(async () => {
  l = await launch({ firstRun: false });
});
test.afterEach(async () => {
  expect(l.errors).toEqual([]);
  await l.app.close();
});

async function addStep(page: Page, menu: string, fill: (dialog: ReturnType<Page['getByTestId']>) => Promise<void>): Promise<void> {
  await page.getByTestId('add-step').click();
  await page.getByRole('menuitem', { name: menu }).click();
  const dialog = page.getByTestId('step-dialog');
  await fill(dialog);
  await page.getByRole('dialog').getByRole('button', { name: 'Add step' }).click();
}

test('cleans data with steps, previews a step, reports a broken step, and saves the steps', async () => {
  const { page, app } = l;
  await importFixtures(l, ['sales.csv']);
  const grid = page.getByTestId('data-grid');
  const steps = page.getByTestId('step');

  await addStep(page, 'Rename a column', async (d) => {
    await d.getByLabel('Column').selectOption('region');
    await d.getByLabel('New name').fill('Area');
  });
  await expect(steps).toHaveText([/Rename region to Area/]);
  await expect(grid.locator('thead')).toContainText('Area');

  await addStep(page, 'Filter rows', async (d) => {
    await d.getByLabel('Column').selectOption('amount');
    await d.getByLabel('Condition').selectOption('>=');
    await d.getByLabel('Value').fill('150');
  });
  // 200, 150, 300 and 250 are at least 150.
  await expect(page.getByText('4 rows', { exact: true })).toBeVisible();
  await expect(grid.locator('tbody tr')).toHaveCount(4);

  // The data as it was after the first step.
  await steps
    .first()
    .getByRole('button', { name: /Rename region to Area/ })
    .click();
  await expect(page.getByTestId('step-preview')).toContainText('after step 1 of 2');
  await expect(grid.locator('tbody tr')).toHaveCount(6);
  await page.getByRole('button', { name: 'Show the result' }).click();
  await expect(grid.locator('tbody tr')).toHaveCount(4);

  // The renamed column is what worksheets see.
  await page.getByText('Sheet 1').click();
  await expect(page.getByTestId('field-Area')).toBeVisible();
  await expect(page.getByTestId('field-region')).toHaveCount(0);
  await page.getByTestId('nav-data').click();

  // A step that refers to a column before it exists is marked, and later steps wait for it.
  await addStep(page, 'Trim or change case', async (d) => {
    await d.getByLabel('Column').selectOption('Area');
    await d.getByLabel('Change').selectOption('upper');
  });
  await expect(grid.locator('tbody tr').first()).toContainText('EAST');
  await page.getByRole('button', { name: 'Move step 3 up' }).click();
  await page.getByRole('button', { name: 'Move step 2 up' }).click();
  await expect(page.getByTestId('step-error')).toContainText('There is no column named "Area"');
  await expect(page.getByText('6 rows', { exact: true })).toBeVisible();
  await shot(page, 'prep-step-error');

  // Undo puts the step back where it was, and the data follows.
  await page.getByRole('button', { name: /Undo/ }).click();
  await page.getByRole('button', { name: /Undo/ }).click();
  await expect(page.getByTestId('step-error')).toHaveCount(0);
  await expect(page.getByText('4 rows', { exact: true })).toBeVisible();
  await expect(grid.locator('tbody tr').first()).toContainText('EAST');
  await shot(page, 'prep-steps');

  // Steps are saved with the project.
  const file = join(tempDir(), 'cleaned.ontology');
  await stubDialogs(app, { save: file });
  await page.getByRole('button', { name: 'Save as…' }).click();
  await expect(page.getByTestId('toast-info').filter({ hasText: 'Saved' })).toBeVisible();
  const saved = JSON.parse(readFileSync(file, 'utf8')) as { model: { tables: { steps: { kind: string }[] }[] } };
  expect(saved.model.tables[0].steps.map((s) => s.kind)).toEqual(['rename', 'filter', 'text']);
});

test('appends one table to another and refreshes it when the source changes', async () => {
  const { page } = l;
  await importFixtures(l, ['sales.csv', 'reps.csv']);
  await page.getByLabel('Table', { exact: true }).selectOption({ label: 'sales' });
  await addStep(page, 'Append another table', async (d) => {
    await d.getByLabel('Table to append').selectOption({ label: 'reps' });
  });
  await expect(page.getByText('10 rows', { exact: true })).toBeVisible();
  await expect(page.getByTestId('data-grid').locator('thead')).toContainText('rep_name');

  // Filter reps down to one row: sales, which appends it, follows.
  await page.getByLabel('Table', { exact: true }).selectOption({ label: 'reps' });
  await addStep(page, 'Filter rows', async (d) => {
    await d.getByLabel('Column').selectOption('team');
    await d.getByLabel('Value').fill('Red');
  });
  await expect(page.getByText('2 rows', { exact: true })).toBeVisible();
  await page.getByLabel('Table', { exact: true }).selectOption({ label: 'sales' });
  await expect(page.getByText('8 rows', { exact: true })).toBeVisible();
});
