import type { DbTable, OpenProjectResult, PasswordInput } from '@shared/api';
import type { Project, TableDef, TableSource } from '@shared/types';
import { askPassword, type DbImport } from './components/DatabaseDialog';
import { pickSheets } from './components/SheetPicker';
import { newId } from './ids';
import { mergeColumns, queueDependents } from './prepSync';
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

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Imports one source as a new table. */
async function importSource(src: TableSource, name: string, password?: PasswordInput): Promise<void> {
  const id = newId('t');
  const r = await window.ontology.importTable(id, src, undefined, password);
  const table: TableDef = {
    id,
    name: uniqueName(
      name,
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
}

/** Imports files into the project as new tables. A workbook with several sheets asks which ones to import. */
export async function importPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      const { sheets, ...src } = await window.ontology.sourceFromPath(path);
      if (src.format === 'sqlite') {
        await importSqlite(src);
        continue;
      }
      if (src.format === 'excel' && sheets && sheets.length > 1) {
        const chosen = await pickSheets(fileName(path), sheets, true);
        for (const sheet of chosen) {
          s().setBusy(`Importing ${baseName(path)} (${sheet})…`);
          try {
            await importSource({ ...src, sheet }, `${baseName(path)} (${sheet})`);
          } catch (e) {
            s().toast('error', `Sheet ${sheet}: ${errText(e)}`);
          } finally {
            s().setBusy(null);
          }
        }
        continue;
      }
      s().setBusy(`Importing ${baseName(path)}…`);
      await importSource(src, baseName(path));
    } catch (e) {
      s().toast('error', errText(e));
    } finally {
      s().setBusy(null);
    }
  }
}

const dbTableLabel = (t: DbTable): string => (t.schema && t.schema !== 'main' ? `${t.schema}.${t.name}` : t.name);

/** Asks which tables of a SQLite file to import, and imports each as its own table. */
async function importSqlite(src: TableSource): Promise<void> {
  s().setBusy(`Reading ${fileName(src.path)}…`);
  let found: DbTable[];
  try {
    found = await window.ontology.listDbTables(src);
  } finally {
    s().setBusy(null);
  }
  if (!found.length) {
    s().toast('warning', `${fileName(src.path)} has no tables.`);
    return;
  }
  const labels = found.map(dbTableLabel);
  const chosen = found.length === 1 ? labels : await pickSheets(fileName(src.path), labels, true, 'table');
  await importDbItems(
    found.filter((t) => chosen.includes(dbTableLabel(t))).map((t) => ({ source: { ...src, table: { schema: t.schema, name: t.name } }, name: t.name }))
  );
}

/** Imports tables from a database (or the result of a query) as new tables. */
export async function importDbItems(items: DbImport[], password?: PasswordInput): Promise<void> {
  for (const item of items) {
    s().setBusy(`Importing ${item.name}…`);
    try {
      await importSource(item.source, item.name, password);
    } catch (e) {
      s().toast('error', `${item.name}: ${errText(e)}`);
    } finally {
      s().setBusy(null);
    }
  }
}

/**
 * The source to use when a table is pointed at a different file. For a workbook, keeps the table's
 * sheet when the new file has a sheet with that name, and otherwise asks. Null when cancelled.
 */
async function sourceForLocatedFile(table: TableDef, path: string): Promise<TableSource | null> {
  const { sheets, ...src } = await window.ontology.sourceFromPath(path);
  if (src.format === 'sqlite') {
    // A moved SQLite file: keep the same table when it is there, otherwise ask.
    const found = await window.ontology.listDbTables(src);
    const want = table.source.table;
    const same = want && found.find((t) => t.name === want.name && (want.schema === undefined || t.schema === want.schema));
    if (same) return { ...src, table: { schema: same.schema, name: same.name } };
    const [label] = await pickSheets(fileName(path), found.map(dbTableLabel), false, 'table');
    const pick = found.find((t) => dbTableLabel(t) === label);
    return pick ? { ...src, table: { schema: pick.schema, name: pick.name } } : null;
  }
  if (src.format !== 'excel' || !sheets || sheets.length < 2) return src;
  if (table.source.sheet && sheets.includes(table.source.sheet)) return { ...src, sheet: table.source.sheet };
  const [sheet] = await pickSheets(fileName(path), sheets, false);
  return sheet ? { ...src, sheet } : null;
}

export async function chooseAndImport(): Promise<void> {
  try {
    const paths = await window.ontology.chooseDataFiles();
    if (paths.length) await importPaths(paths);
  } catch (e) {
    s().toast('error', errText(e));
  }
}

/**
 * Reloads a table from its source file or database and explains any column changes. For a server
 * whose password is not saved (or no longer works), asks for it and tries again.
 */
export async function reloadTable(tableId: string, newPath?: string, password?: PasswordInput): Promise<void> {
  const table = s().project.model.tables.find((t) => t.id === tableId);
  if (!table) return;
  let askFor: string | null = null;
  try {
    let source = table.source;
    if (newPath) {
      const located = await sourceForLocatedFile(table, newPath);
      if (!located) return;
      source = located;
    }
    s().setBusy(`Reloading ${table.name}…`);
    const r = await window.ontology.importTable(tableId, source, table.steps, password);
    const before = new Set(table.columns.map((c) => c.name));
    const after = new Set(r.columns.map((c) => c.name));
    const added = [...after].filter((c) => !before.has(c));
    const removed = [...before].filter((c) => !after.has(c));
    s().update((p) => {
      const t = p.model.tables.find((x) => x.id === tableId);
      if (!t) return;
      t.source = source;
      t.columns = mergeColumns(t.columns, r.columns);
      t.rowCount = r.rowCount;
    });
    s().setTableError(tableId, null);
    s().setStepError(tableId, r.stepError ?? null);
    clearQueryCache();
    s().dataChanged();
    queueDependents(tableId);
    if (added.length || removed.length) {
      const parts = [];
      if (removed.length) parts.push(`removed: ${removed.join(', ')}. Views and calculations that use them will show an error until you fix them`);
      if (added.length) parts.push(`added: ${added.join(', ')}`);
      s().toast('warning', `The columns of ${table.name} changed since the last load. ${parts.join('; ')}.`);
    } else s().toast('info', `Reloaded ${table.name}: ${r.rowCount.toLocaleString('en-US')} rows`);
  } catch (e) {
    const err = e as Error & { code?: string };
    s().setTableError(tableId, err.message);
    if (err.code === 'password') askFor = err.message;
    else s().toast('error', err.code === 'missing' ? `${err.message} Use "Locate file" to point to its new location.` : err.message);
  } finally {
    s().setBusy(null);
  }
  if (askFor !== null) {
    const k = table.source.connection;
    const typed = await askPassword(`Password for ${table.name}`, k ? `${askFor} (${k.database} on ${k.host})` : askFor);
    if (typed) await reloadTable(tableId, newPath, typed);
  }
}

export async function locateTable(tableId: string): Promise<void> {
  const paths = await window.ontology.chooseDataFiles();
  if (paths[0]) await reloadTable(tableId, paths[0]);
}

export async function removeTable(tableId: string): Promise<void> {
  s().update((p) => {
    p.model.tables = p.model.tables.filter((t) => t.id !== tableId);
    p.model.relationships = p.model.relationships.filter((r) => r.fromTable !== tableId && r.toTable !== tableId);
  });
  s().setTableError(tableId, null);
  await window.ontology.dropTable(tableId).catch(() => undefined);
}

function confirmDiscard(): boolean {
  return !s().dirty || window.confirm('You have unsaved changes. Discard them?');
}

function applyOpened(r: OpenProjectResult): void {
  clearQueryCache();
  const errors = Object.fromEntries(r.tableErrors.map((e) => [e.tableId, e.message]));
  const stepErrors = Object.fromEntries(r.stepErrors.map((e) => [e.tableId, { stepId: e.stepId, message: e.message }]));
  s().load(r.project, r.path, errors, stepErrors);
  s().go(r.project.dashboards.some((d) => d.pages.some((p) => p.tiles.length)) ? 'dashboard' : 'worksheet');
  for (const e of r.tableErrors) s().toast('error', e.message);
  for (const e of r.stepErrors) s().toast('error', `A cleaning step could not be applied. ${e.message}`);
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
    const r = await window.ontology.openProject(path);
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
    applyOpened(await window.ontology.openSample());
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
    const path = await window.ontology.saveProject(s().project, s().path, saveAs);
    if (path) {
      s().markSaved(path);
      s().toast('info', `Saved ${path}`);
    }
  } catch (e) {
    s().toast('error', errText(e));
  }
}
