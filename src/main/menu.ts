import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { MenuAction } from '@shared/api';

export function buildMenu(getWindow: () => BrowserWindow | null, devTools: boolean): void {
  const send = (action: MenuAction) => () => getWindow()?.webContents.send('menu', action);
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New project', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open project…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Open sample project', click: send('openSample') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save as…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: 'Import data…', accelerator: 'CmdOrCtrl+I', click: send('import') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        // Undo and redo go to the renderer, which applies them to text fields or to the project.
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('undo') },
        { label: 'Redo', accelerator: isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y', click: send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle light and dark theme', click: send('toggleTheme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(devTools ? [{ role: 'toggleDevTools' as const }] : [])
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'About Super Ontology', click: send('about') },
        { label: `Version ${app.getVersion()}`, enabled: false },
        { type: 'separator' },
        { label: 'Show data folder', click: () => void shell.openPath(app.getPath('userData')) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
