import { app, BrowserWindow, session, shell } from 'electron';
import { join } from 'node:path';

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL'];

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Facet BI',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false
    }
  });
  win.once('ready-to-show', () => win.show());
  // Never navigate away from the app or open new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (isDev) void win.loadURL(process.env['ELECTRON_RENDERER_URL'] as string);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
  return win;
}

function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // No network: block every request that is not a local app file (or the dev server).
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url;
    const devOk = isDev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] as string);
    const ok = url.startsWith('file://') || url.startsWith('devtools://') || url.startsWith('data:') || url.startsWith('blob:') || devOk || (isDev && url.startsWith('ws://localhost'));
    cb({ cancel: !ok });
  });
}

app.whenReady().then(() => {
  lockDownSession();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void shell;
