import { create } from 'zustand';
import type { Dashboard, FilterDef, Project, ThemeName, VizSpec, Worksheet } from '@shared/types';
import { FORMAT_VERSION } from '@shared/types';
import { newId } from './ids';

export type View = 'data' | 'model' | 'worksheet' | 'dashboard';

export interface Toast {
  id: string;
  kind: 'info' | 'error' | 'warning';
  text: string;
}

export interface CrossFilter {
  tileId: string;
  filters: FilterDef[];
  label: string;
  /** Row index of the selected mark in the source tile, for highlighting. */
  key: string;
}

export function emptySpec(): VizSpec {
  return { chartType: 'auto', columns: [], rows: [], tooltip: [], filters: [] };
}

export function newWorksheet(name: string): Worksheet {
  return { id: newId('w'), name, spec: emptySpec() };
}

export function newDashboard(name: string): Dashboard {
  return { id: newId('d'), name, pages: [{ id: newId('p'), name: 'Page 1', tiles: [] }] };
}

export function newProject(): Project {
  return {
    formatVersion: FORMAT_VERSION,
    name: 'Untitled',
    model: { tables: [], relationships: [], calcs: [] },
    worksheets: [newWorksheet('Sheet 1')],
    dashboards: [newDashboard('Dashboard 1')]
  };
}

const HISTORY_LIMIT = 100;

interface State {
  project: Project;
  path: string | null;
  dirty: boolean;
  past: Project[];
  future: Project[];
  view: View;
  worksheetId: string | null;
  dashboardId: string | null;
  pageId: string | null;
  tableId: string | null;
  theme: ThemeName;
  tableErrors: Record<string, string>;
  toasts: Toast[];
  crossFilters: Record<string, CrossFilter | undefined>;
  busy: string | null;

  /** Applies a change to the project. Changes are undoable unless `history` is false. */
  update(fn: (p: Project) => void, opts?: { history?: boolean }): void;
  undo(): void;
  redo(): void;
  load(project: Project, path: string | null, tableErrors?: Record<string, string>): void;
  markSaved(path: string): void;
  go(view: View, id?: string | null): void;
  setPage(pageId: string): void;
  selectTable(id: string | null): void;
  setTheme(t: ThemeName): void;
  toast(kind: Toast['kind'], text: string): void;
  dismiss(id: string): void;
  setTableError(id: string, message: string | null): void;
  setCrossFilter(pageId: string, cf: CrossFilter | undefined): void;
  setBusy(text: string | null): void;
}

export const useStore = create<State>((set, get) => ({
  project: newProject(),
  path: null,
  dirty: false,
  past: [],
  future: [],
  view: 'data',
  worksheetId: null,
  dashboardId: null,
  pageId: null,
  tableId: null,
  theme: initialTheme(),
  tableErrors: {},
  toasts: [],
  crossFilters: {},
  busy: null,

  update(fn, opts) {
    const prev = get().project;
    const next = structuredClone(prev);
    fn(next);
    if (opts?.history === false) {
      set({ project: next, dirty: true });
      return;
    }
    set({ project: next, dirty: true, past: [...get().past, prev].slice(-HISTORY_LIMIT), future: [] });
  },
  undo() {
    const { past, project, future } = get();
    const prev = past[past.length - 1];
    if (!prev) return;
    set({ project: prev, past: past.slice(0, -1), future: [project, ...future], dirty: true });
  },
  redo() {
    const { past, project, future } = get();
    const next = future[0];
    if (!next) return;
    set({ project: next, past: [...past, project], future: future.slice(1), dirty: true });
  },
  load(project, path, tableErrors = {}) {
    const ws = project.worksheets[0]?.id ?? null;
    const db = project.dashboards[0];
    set({
      project,
      path,
      dirty: false,
      past: [],
      future: [],
      tableErrors,
      crossFilters: {},
      worksheetId: ws,
      dashboardId: db?.id ?? null,
      pageId: db?.pages[0]?.id ?? null,
      tableId: project.model.tables[0]?.id ?? null
    });
  },
  markSaved(path) {
    set({ path, dirty: false });
  },
  go(view, id) {
    if (view === 'worksheet') set({ view, worksheetId: id ?? get().worksheetId ?? get().project.worksheets[0]?.id ?? null });
    else if (view === 'dashboard') {
      const dashId = id ?? get().dashboardId ?? get().project.dashboards[0]?.id ?? null;
      const dash = get().project.dashboards.find((d) => d.id === dashId);
      const pageId = dash?.pages.some((p) => p.id === get().pageId) ? get().pageId : (dash?.pages[0]?.id ?? null);
      set({ view, dashboardId: dashId, pageId });
    } else set({ view });
  },
  setPage(pageId) {
    set({ pageId });
  },
  selectTable(id) {
    set({ tableId: id });
  },
  setTheme(theme) {
    try {
      localStorage.setItem('facet-theme', theme);
    } catch {
      // Storage can be unavailable; the theme still applies for this session.
    }
    // The theme is a per-user preference, so it is not saved in (or loaded from) project files.
    set({ theme });
  },
  toast(kind, text) {
    const id = newId('t');
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-5) });
    if (kind !== 'error') setTimeout(() => get().dismiss(id), 6000);
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  setTableError(id, message) {
    const next = { ...get().tableErrors };
    if (message) next[id] = message;
    else delete next[id];
    set({ tableErrors: next });
  },
  setCrossFilter(pageId, cf) {
    set({ crossFilters: { ...get().crossFilters, [pageId]: cf } });
  },
  setBusy(busy) {
    set({ busy });
  }
}));

function initialTheme(): ThemeName {
  try {
    const t = localStorage.getItem('facet-theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    // Fall through to the system preference.
  }
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function useWorksheet(id: string | null): Worksheet | undefined {
  return useStore((s) => s.project.worksheets.find((w) => w.id === id));
}
