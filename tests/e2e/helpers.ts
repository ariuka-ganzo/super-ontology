import { _electron as electron, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = resolve(__dirname, '..', '..');
export const FIXTURES = join(__dirname, 'fixtures');
export const SHOTS = join(ROOT, 'test-results', 'screens');

export interface Launched {
  app: ElectronApplication;
  page: Page;
  userData: string;
  errors: string[];
}

/** Command-line arguments that start the app (the packaged executable needs none; the dev build needs the project folder). */
export function appArgs(extra: string[] = []): string[] {
  const args = process.env['ONTOLOGY_E2E_EXECUTABLE'] ? [] : [ROOT];
  // CI's Linux machines have no GPU. Chromium no longer falls back to software WebGL by itself, and
  // Explore's graph needs WebGL, so tests ask for the software renderer. The app itself does not.
  if (process.platform === 'linux') args.push('--no-sandbox', '--enable-unsafe-swiftshader');
  return [...args, ...extra];
}

/**
 * Launches the built app with its own settings folder. `firstRun: false` skips the sample project.
 * `files` are passed on the command line, as the OS does when a project file is double-clicked.
 */
export async function launch(opts: { firstRun?: boolean; files?: string[] } = {}): Promise<Launched> {
  const userData = mkdtempSync(join(tmpdir(), 'ontology-e2e-'));
  if (opts.firstRun === false) writeFileSync(join(userData, 'settings.json'), JSON.stringify({ firstRunDone: true }));
  // ONTOLOGY_E2E_EXECUTABLE runs the tests against a packaged build instead of the development build.
  const exe = process.env['ONTOLOGY_E2E_EXECUTABLE'];
  const args = appArgs(opts.files);
  if (process.env['ONTOLOGY_SCREENSHOTS']) args.push('--force-device-scale-factor=2');
  const app = await electron.launch({ executablePath: exe || undefined, args, env: { ...process.env, ONTOLOGY_USER_DATA: userData, NODE_ENV: 'production' } });
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('dialog', (d) => void d.accept());
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.topbar')).toBeVisible();
  return { app, page, userData, errors };
}

/** Replaces the native open and save dialogs with fixed answers. */
export async function stubDialogs(app: ElectronApplication, answers: { open?: string[]; save?: string }): Promise<void> {
  await app.evaluate(({ dialog }, a) => {
    dialog.showOpenDialog = (async () => ({ canceled: !a.open, filePaths: a.open ?? [] })) as typeof dialog.showOpenDialog;
    dialog.showSaveDialog = (async () => ({ canceled: !a.save, filePath: a.save ?? '' })) as typeof dialog.showSaveDialog;
  }, answers);
}

export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** Drags with real mouse events, which is what the shelves' pointer sensor listens to. */
export async function drag(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await from.boundingBox();
  const b = await to.boundingBox();
  if (!a || !b) throw new Error('drag target not visible');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 6, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ontology-e2e-out-'));
}

/** Rows of the HTML result table in a container, as text. */
export async function tableRows(scope: Locator): Promise<string[][]> {
  return scope.locator('table.result tbody tr').evaluateAll((rows) => rows.map((r) => Array.from(r.querySelectorAll('td')).map((td) => td.textContent ?? '')));
}

/** Starts an empty project and imports the given fixture files. */
export async function importFixtures(l: Launched, files: string[]): Promise<void> {
  await l.page.getByRole('button', { name: 'New', exact: true }).click();
  await stubDialogs(l.app, { open: files.map((f) => join(FIXTURES, f)) });
  await l.page.locator('.topbar').getByRole('button', { name: 'Import data…' }).click();
  for (const f of files) await expect(l.page.getByTestId('toast-info').filter({ hasText: `Imported ${f.replace(/\.[^.]+$/, '')}` })).toBeVisible();
}
