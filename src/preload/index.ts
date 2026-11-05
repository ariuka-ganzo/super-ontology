// The only bridge between the sandboxed renderer and the main process.
// It exposes named functions; there is no generic invoke.
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { FacetApi, MenuAction } from '../shared/api';

class IpcError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, payload)) as { ok: true; value: T } | { ok: false; error: string; code: string };
  if (r.ok) return r.value;
  throw new IpcError(r.error, r.code);
}

const api: FacetApi = {
  chooseDataFiles: () => call('data:choose'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  sourceFromPath: (path) => call('data:source', path),
  importTable: (tableId, source) => call('data:import', { tableId, source }),
  dropTable: (tableId) => call('data:drop', tableId),
  preview: (table, limit, offset) => call('data:preview', { table, limit, offset }),
  profile: (table, column) => call('data:profile', { table, column }),
  cardinality: (model, rel) => call('data:cardinality', { model, rel }),
  query: (req) => call('query:run', req),
  cancel: (requestId) => call('query:cancel', requestId),
  openProject: (path) => call('project:open', path),
  openSample: () => call('project:sample'),
  saveProject: (project, path, saveAs) => call('project:save', { project, path, saveAs }),
  exportPng: (dataUrl, name) => call('export:png', { dataUrl, name }),
  exportCsv: (req, name) => call('export:csv', { req, name }),
  exportPdf: (name) => call('export:pdf', { name }),
  startup: () => call('app:startup'),
  setTitle: (title, dirty) => call('app:title', { title, dirty }),
  onMenu: (cb) => {
    const listener = (_e: unknown, action: MenuAction): void => cb(action);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  }
};

contextBridge.exposeInMainWorld('facet', api);
