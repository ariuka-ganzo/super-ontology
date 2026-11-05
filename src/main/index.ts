import { app, BrowserWindow, session } from 'electron';
import { join } from 'node:path';
import { Engine } from './engine/engine';
import { registerIpc } from './ipc';
import { buildMenu } from './menu';
import { samplesDir } from './paths';

// Tests and smoke checks can isolate settings in their own folder.
if (process.env['FACET_USER_DATA']) app.setPath('userData', process.env['FACET_USER_DATA']);

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
    title: 'Facet BI',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || process.env['FACET_DEVTOOLS'] === '1'
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
  // No network access: only the app's own files load (and the dev server during development).
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

/** `--smoke-test`: load DuckDB, import the bundled sample, run a query, print the result and exit. */
async function smokeTest(): Promise<void> {
  try {
    const e = await Engine.create();
    const r = await e.importTable('smoke', { path: join(samplesDir(), 'orders.csv'), format: 'csv' });
    const rows = await e.unsafeRawForTests('SELECT COUNT(*), version() FROM t_smoke');
    e.close();
    process.stdout.write(`FACET_SMOKE_OK rows=${r.rowCount} count=${rows[0][0]} duckdb=${rows[0][1]} packaged=${app.isPackaged}\n`);
    app.exit(0);
  } catch (err) {
    process.stderr.write(`FACET_SMOKE_FAIL ${(err as Error).stack ?? err}\n`);
    app.exit(1);
  }
}

if (process.argv.includes('--smoke-test')) {
  app.whenReady().then(smokeTest);
} else {
  if (!app.requestSingleInstanceLock()) app.quit();
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    lockDownSession();
    engine = await Engine.create();
    registerIpc(engine, () => mainWindow);
    buildMenu(() => mainWindow, !app.isPackaged);
    mainWindow = createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('will-quit', () => engine?.close());
}
