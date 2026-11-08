// Keeps the engine's tables in step with the cleaning steps in the project.
//
// Steps change through edits, undo and redo, so rather than re-applying them from every place that
// edits them, this watches the project: when a table's steps differ from the ones last applied, it
// asks the engine to apply them and stores the resulting columns and row count (without adding an
// undo entry). Tables whose steps append that table are refreshed after it, one at a time.
import type { PrepareResult } from '@shared/api';
import { appendSources } from '@shared/prep/prep';
import type { ColumnDef, TableDef } from '@shared/types';
import { clearQueryCache } from './query';
import { useStore } from './store';

const s = (): ReturnType<typeof useStore.getState> => useStore.getState();

/** The steps last applied to each table, as JSON. */
const applied = new Map<string, string>();
let queue: Promise<void> = Promise.resolve();

const signature = (t: TableDef): string => JSON.stringify(t.steps ?? []);
const tableById = (id: string): TableDef | undefined => s().project.model.tables.find((t) => t.id === id);

/** Keeps type overrides for columns that still exist. */
export function mergeColumns(old: ColumnDef[], next: ColumnDef[]): ColumnDef[] {
  return next.map((c) => {
    const o = old.find((x) => x.name === c.name);
    return o?.override ? { ...c, override: o.override } : c;
  });
}

/** Stores the result of applying a table's steps: columns, row count and any step error. */
export function storePrepared(tableId: string, r: PrepareResult): void {
  s().update(
    (p) => {
      const t = p.model.tables.find((x) => x.id === tableId);
      if (!t) return;
      t.columns = mergeColumns(t.columns, r.columns);
      t.rowCount = r.rowCount;
    },
    { history: false }
  );
  s().setStepError(tableId, r.stepError ?? null);
  const t = tableById(tableId);
  if (t) applied.set(t.id, signature(t));
  clearQueryCache();
  s().dataChanged();
}

async function apply(tableId: string, done: Set<string>): Promise<void> {
  const t = tableById(tableId);
  if (!t || s().tableErrors[tableId]) return;
  const sig = signature(t);
  try {
    const r = await window.ontology.applySteps(tableId, t.steps ?? []);
    // If the steps changed again while this ran, the newer change is already queued.
    const now = tableById(tableId);
    if (!now || signature(now) !== sig) return;
    storePrepared(tableId, r);
  } catch (e) {
    s().toast('error', `${t.name}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  done.add(tableId);
  await refreshDependents(tableId, done);
}

/** Re-applies the steps of tables that append `tableId`, for example after it was reloaded. */
export async function refreshDependents(tableId: string, done = new Set([tableId])): Promise<void> {
  for (const d of s().project.model.tables) {
    if (done.has(d.id) || !appendSources(d.steps).includes(tableId)) continue;
    done.add(d.id);
    await apply(d.id, done);
  }
}

function enqueue(fn: () => Promise<void>): void {
  queue = queue.then(fn, fn);
}

/** Queues a refresh of the tables that append `tableId`. */
export function queueDependents(tableId: string): void {
  enqueue(() => refreshDependents(tableId));
}

/** Starts watching the project. Returns a function that stops it. */
export function startPrepSync(): () => void {
  return useStore.subscribe((state, prev) => {
    if (state.project === prev.project) return;
    for (const t of state.project.model.tables) {
      const sig = signature(t);
      const known = applied.get(t.id);
      // A table seen for the first time was just imported or opened, and the engine applied its steps then.
      if (known === undefined) applied.set(t.id, sig);
      else if (known !== sig) {
        applied.set(t.id, sig);
        enqueue(() => apply(t.id, new Set()));
      }
    }
  });
}
