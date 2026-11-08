import { useEffect, useState } from 'react';
import type { MenuAction } from '@shared/api';
import { chooseAndImport, importPaths, newProjectAction, openProject, openSample, saveProject } from './actions';
import { MenuItem, Popover } from './components/Popover';
import { Modal } from './components/Modal';
import { PasswordPrompt } from './components/DatabaseDialog';
import { SheetPicker } from './components/SheetPicker';
import { newId } from './ids';
import { startPrepSync } from './prepSync';
import { newDashboard, newWorksheet, useStore, type View } from './store';
import { DashboardView } from './views/DashboardView';
import { DataView } from './views/DataView';
import { ModelView } from './views/ModelView';
import { WorksheetView } from './views/WorksheetView';

export function Logo(): React.JSX.Element {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2l8.66 5v10L12 22l-8.66-5V7z" fill="var(--accent)" />
      <path d="M12 2l8.66 5L12 12z" fill="#fff" opacity="0.35" />
      <path d="M12 12l8.66-5v10z" fill="#000" opacity="0.15" />
      <path d="M12 12v10l-8.66-5z" fill="#000" opacity="0.3" />
    </svg>
  );
}

function isTextField(el: Element | null): boolean {
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el as HTMLElement).isContentEditable);
}

export function App(): React.JSX.Element {
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const name = useStore((s) => s.project.name);
  const dirty = useStore((s) => s.dirty);
  const toasts = useStore((s) => s.toasts);
  const busy = useStore((s) => s.busy);
  const [dropping, setDropping] = useState(false);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => startPrepSync(), []);

  useEffect(() => {
    void window.ontology.setTitle(name || 'Untitled', dirty);
  }, [name, dirty]);

  useEffect(() => {
    // Listen before asking for startup info, so a file opened from the OS in between is not lost.
    const off = window.ontology.onOpenPath((path) => void openProject(path));
    void window.ontology.startup().then((info) => {
      if (info.openPath) void openProject(info.openPath);
      else if (info.firstRun) void openSample(true);
    });
    return off;
  }, []);

  useEffect(() => {
    const s = useStore.getState;
    const handle = (a: MenuAction): void => {
      switch (a) {
        case 'new':
          return newProjectAction();
        case 'open':
          return void openProject();
        case 'openSample':
          return void openSample();
        case 'save':
          return void saveProject(false);
        case 'saveAs':
          return void saveProject(true);
        case 'import':
          return void chooseAndImport();
        case 'undo':
          if (isTextField(document.activeElement)) document.execCommand('undo');
          else s().undo();
          return;
        case 'redo':
          if (isTextField(document.activeElement)) document.execCommand('redo');
          else s().redo();
          return;
        case 'toggleTheme':
          return s().setTheme(s().theme === 'dark' ? 'light' : 'dark');
        case 'about':
          return setAbout(true);
      }
    };
    return window.ontology.onMenu(handle);
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent): void => {
      if (useStore.getState().dirty && !navigator.webdriver) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const hasFiles = (e: React.DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files');

  return (
    <div
      className="app"
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null) setDropping(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDropping(false);
        const paths = Array.from(e.dataTransfer.files)
          .map((f) => window.ontology.pathForFile(f))
          .filter(Boolean);
        if (paths.length) void importPaths(paths);
      }}
    >
      <TopBar />
      <Nav />
      <main className="main">
        {view === 'data' && <DataView />}
        {view === 'model' && <ModelView />}
        {view === 'worksheet' && <WorksheetView />}
        {view === 'dashboard' && <DashboardView />}
      </main>
      {dropping && <div className="dropzone">Drop files to import them</div>}
      {busy && <div className="busy">{busy}</div>}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} data-testid={`toast-${t.kind}`}>
            <span className="text">{t.text}</span>
            <button className="small ghost" onClick={() => useStore.getState().dismiss(t.id)} aria-label="Dismiss">
              ✕
            </button>
          </div>
        ))}
      </div>
      <SheetPicker />
      <PasswordPrompt />
      {about && (
        <Modal title="About Super Ontology" onClose={() => setAbout(false)}>
          <div className="col">
            <div className="row">
              <Logo />
              <b>Super Ontology 0.1</b>
            </div>
            <p>A free, open-source desktop app for exploring local data and building interactive dashboards. MIT licence.</p>
            <p className="muted">
              Your data stays on your computer. Super Ontology collects no telemetry, and only connects to database servers you add yourself.
            </p>
            <p className="muted">Built with Electron, React, DuckDB and Apache ECharts.</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function TopBar(): React.JSX.Element {
  const name = useStore((s) => s.project.name);
  const dirty = useStore((s) => s.dirty);
  const canUndo = useStore((s) => s.past.length > 0);
  const canRedo = useStore((s) => s.future.length > 0);
  const theme = useStore((s) => s.theme);
  const s = useStore.getState;
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        Super Ontology
      </div>
      <input
        className="project-name"
        aria-label="Project name"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => (v.trim() && v !== name ? s().update((p) => void (p.name = v.trim())) : setV(name))}
      />
      {dirty && (
        <span className="dirty-dot" title="Unsaved changes">
          •
        </span>
      )}
      <span className="spacer" />
      <button className="ghost" onClick={() => s().undo()} disabled={!canUndo} title="Undo (Ctrl+Z)">
        ↶ Undo
      </button>
      <button className="ghost" onClick={() => s().redo()} disabled={!canRedo} title="Redo (Ctrl+Y)">
        ↷ Redo
      </button>
      <button className="ghost" onClick={newProjectAction}>
        New
      </button>
      <button className="ghost" onClick={() => void openProject()}>
        Open…
      </button>
      <button className="ghost" onClick={() => void saveProject(false)}>
        Save
      </button>
      <button className="ghost" onClick={() => void saveProject(true)}>
        Save as…
      </button>
      <button onClick={() => void chooseAndImport()}>Import data…</button>
      <button className="ghost" onClick={() => s().setTheme(theme === 'dark' ? 'light' : 'dark')} title="Switch light and dark theme" aria-label="Toggle theme">
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </header>
  );
}

function Nav(): React.JSX.Element {
  const view = useStore((s) => s.view);
  const worksheets = useStore((s) => s.project.worksheets);
  const dashboards = useStore((s) => s.project.dashboards);
  const wsId = useStore((s) => s.worksheetId);
  const dbId = useStore((s) => s.dashboardId);
  const tables = useStore((s) => s.project.model.tables.length);
  const errors = useStore((s) => Object.keys(s.tableErrors).length);
  const go = useStore((s) => s.go);
  const update = useStore((s) => s.update);
  const [menu, setMenu] = useState<{ el: HTMLElement; kind: 'worksheet' | 'dashboard'; id: string } | null>(null);

  const item = (v: View, label: string, icon: string, extra?: React.ReactNode): React.JSX.Element => (
    <button className={`nav-item${view === v ? ' active' : ''}`} onClick={() => go(v)} data-testid={`nav-${v}`}>
      <span className="icon">{icon}</span>
      <span className="label grow">{label}</span>
      {extra}
    </button>
  );

  const addWorksheet = (): void => {
    const w = newWorksheet(`Sheet ${worksheets.length + 1}`);
    update((p) => void p.worksheets.push(w));
    go('worksheet', w.id);
  };
  const addDashboard = (): void => {
    const d = newDashboard(`Dashboard ${dashboards.length + 1}`);
    update((p) => void p.dashboards.push(d));
    go('dashboard', d.id);
  };

  return (
    <nav className="nav">
      {item(
        'data',
        'Data',
        '▤',
        <span className="faint">
          {tables || ''}
          {errors ? ' ⚠' : ''}
        </span>
      )}
      {item('model', 'Model', '⛓')}
      <div className="nav-section">
        <h3 className="grow">Worksheets</h3>
        <button className="small ghost" onClick={addWorksheet} title="New worksheet" data-testid="add-worksheet">
          +
        </button>
      </div>
      {worksheets.map((w) => (
        <button
          key={w.id}
          className={`nav-item${view === 'worksheet' && wsId === w.id ? ' active' : ''}`}
          onClick={() => go('worksheet', w.id)}
          onContextMenu={(e) => (e.preventDefault(), setMenu({ el: e.currentTarget, kind: 'worksheet', id: w.id }))}
          title="Right-click to rename, duplicate or delete"
        >
          <span className="icon">▦</span>
          <span className="label">{w.name}</span>
        </button>
      ))}
      <div className="nav-section">
        <h3 className="grow">Dashboards</h3>
        <button className="small ghost" onClick={addDashboard} title="New dashboard" data-testid="add-dashboard">
          +
        </button>
      </div>
      {dashboards.map((d) => (
        <button
          key={d.id}
          className={`nav-item${view === 'dashboard' && dbId === d.id ? ' active' : ''}`}
          onClick={() => go('dashboard', d.id)}
          onContextMenu={(e) => (e.preventDefault(), setMenu({ el: e.currentTarget, kind: 'dashboard', id: d.id }))}
          title="Right-click to rename or delete"
        >
          <span className="icon">◫</span>
          <span className="label">{d.name}</span>
        </button>
      ))}
      {menu && (
        <Popover anchor={menu.el} onClose={() => setMenu(null)}>
          <MenuItem
            onClick={() => {
              const list = menu.kind === 'worksheet' ? worksheets : dashboards;
              const cur = list.find((x) => x.id === menu.id);
              const n = window.prompt('Name', cur?.name ?? '');
              if (n?.trim())
                update((p) => {
                  const target = (menu.kind === 'worksheet' ? p.worksheets : p.dashboards).find((x) => x.id === menu.id);
                  if (target) target.name = n.trim();
                });
              setMenu(null);
            }}
          >
            Rename
          </MenuItem>
          {menu.kind === 'worksheet' && (
            <MenuItem
              onClick={() => {
                const src = worksheets.find((w) => w.id === menu.id);
                if (src) {
                  const copy = { ...structuredClone(src), id: newId('w'), name: `${src.name} copy` };
                  update((p) => void p.worksheets.push(copy));
                  go('worksheet', copy.id);
                }
                setMenu(null);
              }}
            >
              Duplicate
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              update((p) => {
                if (menu.kind === 'worksheet') p.worksheets = p.worksheets.filter((w) => w.id !== menu.id);
                else p.dashboards = p.dashboards.filter((d) => d.id !== menu.id);
              });
              setMenu(null);
            }}
          >
            Delete
          </MenuItem>
        </Popover>
      )}
    </nav>
  );
}
