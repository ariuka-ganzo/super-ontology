import { app, BrowserWindow, session } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from './engine/engine';
import { registerIpc } from './ipc';
import { PendingOpen, projectFromArgv } from './open-file';
import { buildMenu } from './menu';
import { extensionsDir, samplesDir } from './paths';

// Tests and smoke checks can isolate settings in their own folder.
if (process.env['ONTOLOGY_USER_DATA']) app.setPath('userData', process.env['ONTOLOGY_USER_DATA']);

const devUrl = !app.isPackaged ? process.env['ELECTRON_RENDERER_URL'] : undefined;
let mainWindow: BrowserWindow | null = null;
let engine: Engine | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    title: 'Super Ontology',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env['ONTOLOGY_DEVTOOLS'] === '1'
    }
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // The window has no network access: only the app's own files load (and the dev server during development).
  // Database connections are made by DuckDB in the main process, not by the window.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url;
    const ok =
      url.startsWith('file://') ||
      url.startsWith('devtools://') ||
      url.startsWith('data:') ||
      url.startsWith('blob:') ||
      (!!devUrl && (url.startsWith(devUrl) || url.startsWith('ws://localhost')));
    cb({ cancel: !ok });
  });
}

/** GUI apps on Windows have no console, so the smoke result can also go to a file. */
function report(line: string): void {
  process.stdout.write(line);
  const out = process.env['ONTOLOGY_SMOKE_OUT'];
  if (out) writeFileSync(out, line);
}

/** `--smoke-test`: load DuckDB, import the bundled sample, run a query, print the result and exit. */
async function smokeTest(): Promise<void> {
  try {
    const e = await Engine.create({ extensionsDir: extensionsDir() });
    const r = await e.importTable('smoke', { path: join(samplesDir(), 'orders.csv'), format: 'csv' });
    const rows = await e.unsafeRawForTests('SELECT COUNT(*), version() FROM t_smoke');
    // Loading the database connectors checks that they were packaged and that their signatures are valid.
    const connectors = await e.connector.selfTest();
    e.close();
    report(
      `ONTOLOGY_SMOKE_OK rows=${r.rowCount} count=${rows[0][0]} duckdb=${rows[0][1]} connectors=${connectors} packaged=${app.isPackaged} resources=${process.resourcesPath}\n`
    );
    app.exit(0);
  } catch (err) {
    report(`ONTOLOGY_SMOKE_FAIL ${(err as Error).stack ?? err}\n`);
    app.exit(1);
  }
}

/** Project files opened from the OS wait here until the renderer is ready for them. */
const pendingOpen = new PendingOpen((path) => {
  if (!mainWindow || mainWindow.webContents.isLoading()) return false;
  mainWindow.webContents.send('open-path', path);
  return true;
});

function showWindow(): void {
  if (!engine) return; // Not ready yet: the window is created once the engine starts.
  if (!mainWindow) {
    pendingOpen.reset();
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

if (process.argv.includes('--smoke-test')) {
  app.whenReady().then(smokeTest);
} else if (!app.requestSingleInstanceLock()) {
  // Another instance is running. It receives our arguments through 'second-instance'.
  app.quit();
} else {
  const fromArgs = projectFromArgv(process.argv, process.cwd());
  if (fromArgs) pendingOpen.request(fromArgs);

  app.on('second-instance', (_e, argv, workingDirectory) => {
    const path = projectFromArgv(argv, workingDirectory);
    if (path) pendingOpen.request(path);
    showWindow();
  });
  // macOS delivers opened files as events, possibly before the app is ready.
  app.on('open-file', (e, path) => {
    e.preventDefault();
    pendingOpen.request(path);
    showWindow();
  });

  app.whenReady().then(async () => {
    lockDownSession();
    engine = await Engine.create({ extensionsDir: extensionsDir() });
    registerIpc(
      engine,
      () => mainWindow,
      () => pendingOpen.take()
    );
    buildMenu(() => mainWindow, !app.isPackaged);
    mainWindow = createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) showWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => engine?.close());
}
