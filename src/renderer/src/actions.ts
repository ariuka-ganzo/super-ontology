import type { OpenProjectResult } from '@shared/api';
import type { Project, TableDef } from '@shared/types';
import { newId } from './ids';
import { clearQueryCache } from './query';
import { newProject, useStore } from './store';

const s = (): ReturnType<typeof useStore.getState> => useStore.getState();

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function baseName(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.replace(/\.[^.]+$/, '');
}

function uniqueName(name: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let i = 2; ; i++) if (!lower.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
}

/** Imports files into the project as new tables. */
export async function importPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    s().setBusy(`Importing ${baseName(path)}…`);
    try {
      const source = await window.facet.sourceFromPath(path);
      const id = newId('t');
      const { sheets, ...src } = source;
      const r = await window.facet.importTable(id, src);
      const table: TableDef = {
        id,
        name: uniqueName(
          baseName(path) + (src.format === 'excel' && sheets && sheets.length > 1 ? ` (${src.sheet})` : ''),
          s().project.model.tables.map((t) => t.name)
        ),
        source: src,
        columns: r.columns,
        rowCount: r.rowCount
      };
      s().update((p) => {
        p.model.tables.push(table);
        if (p.name === 'Untitled' && p.model.tables.length === 1) p.name = table.name;
      });
      s().selectTable(id);
      s().go('data');
      s().toast('info', `Imported ${table.name}: ${r.rowCount.toLocaleString('en-US')} rows in ${(r.elapsedMs / 1000).toFixed(2)} s`);
    } catch (e) {
      s().toast('error', errText(e));
    } finally {
      s().setBusy(null);
    }
  }
}

export async function chooseAndImport(): Promise<void> {
  try {
    const paths = await window.facet.chooseDataFiles();
    if (paths.length) await importPaths(paths);
  } catch (e) {
    s().toast('error', errText(e));
  }
}

/** Reloads a table from its source file and explains any column changes. */
export async function reloadTable(tableId: string, newPath?: string): Promise<void> {
  const table = s().project.model.tables.find((t) => t.id === tableId);
  if (!table) return;
  s().setBusy(`Reloading ${table.name}…`);
  try {
    let source = table.source;
    if (newPath) {
      const { sheets: _sheets, ...src } = await window.facet.sourceFromPath(newPath);
      source = src;
    }
    const r = await window.facet.importTable(tableId, source);
    const before = new Set(table.columns.map((c) => c.name));
    const after = new Set(r.columns.map((c) => c.name));
    const added = [...after].filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !after.has(c));
    s().update((p) => {
      const t = p.model.tables.find((x) => x.id === tableId);
      if (!t) return;
      t.source = source;
      t.columns = r.columns.map((c) => {
        const old = t.columns.find((o) => o.name === c.name);
        return old?.override ? { ...c, override: old.override } : c;
      });
      t.rowCount = r.rowCount;
    });
    s().setTableError(tableId, null);
    clearQueryCache();
    if (added.length || removed.length) {
      const parts = [];
      if (removed.length) parts.push(`removed: ${removed.join(', ')}. Views and calculations that use them will show an error until you fix them`);
      if (added.length) parts.push(`added: ${added.join(', ')}`);
      s().toast('warning', `The columns of ${table.name} changed since the last load. ${parts.join('; ')}.`);
    } else s().toast('info', `Reloaded ${table.name}: ${r.rowCount.toLocaleString('en-US')} rows`);
  } catch (e) {
    const err = e as Error & { code?: string };
    s().setTableError(tableId, err.message);
    s().toast('error', err.code === 'missing' ? `${err.message} Use "Locate file" to point to its new location.` : err.message);
  } finally {
    s().setBusy(null);
  }
}

export async function locateTable(tableId: string): Promise<void> {
  const paths = await window.facet.chooseDataFiles();
  if (paths[0]) await reloadTable(tableId, paths[0]);
}

export async function removeTable(tableId: string): Promise<void> {
  s().update((p) => {
    p.model.tables = p.model.tables.filter((t) => t.id !== tableId);
    p.model.relationships = p.model.relationships.filter((r) => r.fromTable !== tableId && r.toTable !== tableId);
  });
  s().setTableError(tableId, null);
  await window.facet.dropTable(tableId).catch(() => undefined);
}

function confirmDiscard(): boolean {
  return !s().dirty || window.confirm('You have unsaved changes. Discard them?');
}

function applyOpened(r: OpenProjectResult): void {
  clearQueryCache();
  const errors = Object.fromEntries(r.tableErrors.map((e) => [e.tableId, e.message]));
  s().load(r.project, r.path, errors);
  s().go(r.project.dashboards.some((d) => d.pages.some((p) => p.tiles.length)) ? 'dashboard' : 'worksheet');
  for (const e of r.tableErrors) s().toast('error', e.message);
  for (const c of r.changed) {
    const t = r.project.model.tables.find((x) => x.id === c.tableId);
    s().toast(
      'warning',
      `The columns of ${t?.name ?? 'a table'} changed since the project was saved (added: ${c.added.join(', ') || 'none'}; removed: ${c.removed.join(', ') || 'none'}).`
    );
  }
}

export async function openProject(path?: string): Promise<void> {
  if (!confirmDiscard()) return;
  s().setBusy('Opening project…');
  try {
    const r = await window.facet.openProject(path);
    if (r) applyOpened(r);
  } catch (e) {
    s().toast('error', errText(e));
  } finally {
    s().setBusy(null);
  }
}

export async function openSample(skipConfirm = false): Promise<void> {
  if (!skipConfirm && !confirmDiscard()) return;
  s().setBusy('Opening sample project…');
  try {
    applyOpened(await window.facet.openSample());
  } catch (e) {
    s().toast('error', errText(e));
  } finally {
    s().setBusy(null);
  }
}

export function newProjectAction(): void {
  if (!confirmDiscard()) return;
  clearQueryCache();
  const p: Project = newProject();
  s().load(p, null);
  s().go('data');
}

export async function saveProject(saveAs = false): Promise<void> {
  try {
    const path = await window.facet.saveProject(s().project, s().path, saveAs);
    if (path) {
      s().markSaved(path);
      s().toast('info', `Saved ${path}`);
    }
  } catch (e) {
    s().toast('error', errText(e));
  }
}
