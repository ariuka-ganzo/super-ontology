import { useCallback, useMemo, useState } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { itemLabel } from '@shared/compiler/compile';
import { formatValue } from '@shared/format';
import type { Dashboard, DashboardPage, FieldRef, FilterDef, QueryResult, Scalar, SlicerState, SlicerType, Tile, VizSpec } from '@shared/types';
import { markFilters, rowKey, bind } from '../chart/options';
import { Modal } from '../components/Modal';
import { MenuItem, Popover } from '../components/Popover';
import { ViewChart } from '../components/ViewChart';
import { fieldInfo, isTemporal, listFields } from '../fields';
import { newId } from '../ids';
import { useVizQuery } from '../query';
import { useStore, type CrossFilter } from '../store';

const Grid = WidthProvider(GridLayout);

export function DashboardView(): React.JSX.Element {
  const dashId = useStore((s) => s.dashboardId);
  const dash = useStore((s) => s.project.dashboards.find((d) => d.id === dashId));
  if (!dash) return <div className="empty">Pick or create a dashboard in the sidebar.</div>;
  return <DashboardEditor dash={dash} />;
}

function slicerFilter(t: Extract<Tile, { kind: 'slicer' }>): FilterDef | null {
  const st = t.state;
  if (!st) return null;
  if (t.slicerType === 'list') return st.values && st.values.length ? { id: `s_${t.id}`, kind: 'values', field: t.field, values: st.values } : null;
  if ((st.min === undefined || st.min === null || st.min === '') && (st.max === undefined || st.max === null || st.max === '')) return null;
  return { id: `s_${t.id}`, kind: 'range', field: t.field, min: st.min === '' ? undefined : st.min, max: st.max === '' ? undefined : st.max };
}

function DashboardEditor({ dash }: { dash: Dashboard }): React.JSX.Element {
  const pageId = useStore((s) => s.pageId);
  const setPage = useStore((s) => s.setPage);
  const update = useStore((s) => s.update);
  const toast = useStore((s) => s.toast);
  const worksheets = useStore((s) => s.project.worksheets);
  const page = dash.pages.find((p) => p.id === pageId) ?? dash.pages[0];
  const cross = useStore((s) => s.crossFilters[page.id]);
  const setCross = useStore((s) => s.setCrossFilter);
  const [addMenu, setAddMenu] = useState<HTMLElement | null>(null);
  const [slicerDialog, setSlicerDialog] = useState(false);

  const editPage = useCallback(
    (fn: (p: DashboardPage) => void, history = true) =>
      update(
        (proj) => {
          const pg = proj.dashboards.find((d) => d.id === dash.id)?.pages.find((p) => p.id === page.id);
          if (pg) fn(pg);
        },
        { history }
      ),
    [update, dash.id, page.id]
  );

  const nextY = page.tiles.reduce((m, t) => Math.max(m, t.layout.y + t.layout.h), 0);
  const addTile = (t: Tile): void => editPage((p) => void p.tiles.push(t));

  const slicerFilters = useMemo(
    () => page.tiles.flatMap((t) => (t.kind === 'slicer' ? [slicerFilter(t)].filter((f): f is FilterDef => !!f) : [])),
    [page.tiles]
  );

  const layout: Layout[] = page.tiles.map((t) => ({ i: t.id, ...t.layout, minW: 2, minH: t.kind === 'text' ? 1 : 2 }));
  const onLayoutChange = (l: Layout[]): void => {
    const changed = l.some((x) => {
      const t = page.tiles.find((tt) => tt.id === x.i);
      return t && (t.layout.x !== x.x || t.layout.y !== x.y || t.layout.w !== x.w || t.layout.h !== x.h);
    });
    if (!changed) return;
    editPage((p) => {
      for (const x of l) {
        const t = p.tiles.find((tt) => tt.id === x.i);
        if (t) t.layout = { x: x.x, y: x.y, w: x.w, h: x.h };
      }
    });
  };

  const exportPdf = async (): Promise<void> => {
    try {
      const path = await window.ontology.exportPdf(`${dash.name} - ${page.name}`);
      if (path) toast('info', `Saved ${path}`);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <div className="view">
      <div className="view-header">
        <DashName dash={dash} />
        <div className="page-tabs no-print">
          {dash.pages.map((p) => (
            <PageTab key={p.id} dash={dash} page={p} active={p.id === page.id} onSelect={() => setPage(p.id)} />
          ))}
          <button
            className="small ghost"
            title="Add page"
            onClick={() => {
              const id = newId('p');
              update((proj) => {
                proj.dashboards.find((d) => d.id === dash.id)?.pages.push({ id, name: `Page ${dash.pages.length + 1}`, tiles: [] });
              });
              setPage(id);
            }}
          >
            + Page
          </button>
        </div>
        <span className="spacer" />
        {cross && (
          <span className="crossfilter-chip" data-testid="crossfilter-chip">
            Filtered by {cross.label}
            <button className="small ghost" onClick={() => setCross(page.id, undefined)} aria-label="Clear cross-filter">
              Clear ✕
            </button>
          </span>
        )}
        <button className="no-print" onClick={(e) => setAddMenu(e.currentTarget)}>
          + Add tile
        </button>
        <button className="no-print" onClick={() => void exportPdf()}>
          Export PDF
        </button>
        {addMenu && (
          <Popover anchor={addMenu} onClose={() => setAddMenu(null)}>
            {worksheets.map((w) => (
              <MenuItem
                key={w.id}
                onClick={() => {
                  addTile({ id: newId('x'), kind: 'worksheet', worksheetId: w.id, layout: { x: 0, y: nextY, w: 6, h: 6 } });
                  setAddMenu(null);
                }}
              >
                Worksheet: {w.name}
              </MenuItem>
            ))}
            <MenuItem
              onClick={() => {
                addTile({ id: newId('x'), kind: 'text', text: '# Title\nDouble-click to edit this text.', layout: { x: 0, y: nextY, w: 12, h: 2 } });
                setAddMenu(null);
              }}
            >
              Text
            </MenuItem>
            <MenuItem
              onClick={() => {
                setSlicerDialog(true);
                setAddMenu(null);
              }}
            >
              Slicer…
            </MenuItem>
          </Popover>
        )}
      </div>
      <div className="view-body">
        {page.tiles.length === 0 ? (
          <div className="empty">
            <h2>This page is empty</h2>
            <span>Add worksheets, text and slicers with “+ Add tile”. Drag a tile by its title to move it and use its corner to resize.</span>
          </div>
        ) : (
          <div className="canvas" data-testid="dashboard-canvas">
            <Grid
              layout={layout}
              cols={12}
              rowHeight={44}
              margin={[10, 10]}
              draggableHandle=".drag-handle"
              onLayoutChange={onLayoutChange}
              compactType="vertical"
            >
              {page.tiles.map((t) => (
                <div key={t.id}>
                  <TileView
                    tile={t}
                    pageId={page.id}
                    slicerFilters={slicerFilters}
                    cross={cross}
                    onRemove={() => editPage((p) => void (p.tiles = p.tiles.filter((x) => x.id !== t.id)))}
                    editPage={editPage}
                  />
                </div>
              ))}
            </Grid>
          </div>
        )}
      </div>
      {slicerDialog && (
        <SlicerDialog
          onClose={() => setSlicerDialog(false)}
          onAdd={(field, slicerType) =>
            addTile({ id: newId('x'), kind: 'slicer', field, slicerType, layout: { x: 0, y: nextY, w: 3, h: slicerType === 'list' ? 5 : 3 } })
          }
        />
      )}
    </div>
  );
}

function DashName({ dash }: { dash: Dashboard }): React.JSX.Element {
  const update = useStore((s) => s.update);
  const [v, setV] = useState(dash.name);
  return (
    <input
      aria-label="Dashboard name"
      className="project-name"
      style={{ fontSize: 15, width: 200 }}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() =>
        v.trim() && v !== dash.name
          ? update((p) => {
              const d = p.dashboards.find((x) => x.id === dash.id);
              if (d) d.name = v.trim();
            })
          : setV(dash.name)
      }
    />
  );
}

function PageTab({ dash, page, active, onSelect }: { dash: Dashboard; page: DashboardPage; active: boolean; onSelect: () => void }): React.JSX.Element {
  const update = useStore((s) => s.update);
  const setPage = useStore((s) => s.setPage);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        className={`page-tab small${active ? ' active' : ''}`}
        onClick={onSelect}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu(e.currentTarget);
        }}
        onDoubleClick={(e) => setMenu(e.currentTarget)}
        title="Double-click or right-click to rename or delete"
      >
        {page.name}
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          <MenuItem
            onClick={() => {
              const name = window.prompt('Page name', page.name);
              if (name?.trim())
                update((p) => {
                  const pg = p.dashboards.find((d) => d.id === dash.id)?.pages.find((x) => x.id === page.id);
                  if (pg) pg.name = name.trim();
                });
              setMenu(null);
            }}
          >
            Rename
          </MenuItem>
          {dash.pages.length > 1 && (
            <MenuItem
              onClick={() => {
                update((p) => {
                  const d = p.dashboards.find((x) => x.id === dash.id);
                  if (d) d.pages = d.pages.filter((x) => x.id !== page.id);
                });
                setPage(dash.pages.find((p) => p.id !== page.id)?.id ?? '');
                setMenu(null);
              }}
            >
              Delete page
            </MenuItem>
          )}
        </Popover>
      )}
    </>
  );
}

function TileView({
  tile,
  pageId,
  slicerFilters,
  cross,
  onRemove,
  editPage
}: {
  tile: Tile;
  pageId: string;
  slicerFilters: FilterDef[];
  cross?: CrossFilter;
  onRemove: () => void;
  editPage: (fn: (p: DashboardPage) => void, history?: boolean) => void;
}): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const ws = useStore((s) => (tile.kind === 'worksheet' ? s.project.worksheets.find((w) => w.id === tile.worksheetId) : undefined));
  const setCross = useStore((s) => s.setCrossFilter);
  const go = useStore((s) => s.go);
  const [editingText, setEditingText] = useState(false);

  const title =
    tile.kind === 'worksheet'
      ? (tile.title ?? ws?.name ?? 'Missing worksheet')
      : tile.kind === 'slicer'
        ? (tile.title ?? itemLabel({ id: 'x', field: tile.field, role: 'dimension' }, model))
        : '';
  const isSource = cross?.tileId === tile.id;
  const external = useMemo(() => [...slicerFilters, ...(cross && cross.tileId !== tile.id ? cross.filters : [])], [slicerFilters, cross, tile.id]);

  const onMarkClick = useCallback(
    (ri: number, result: QueryResult) => {
      if (!ws) return;
      const L = bind(ws.spec, result);
      if (L.dims.length === 0) return;
      const key = rowKey(L, result.rows[ri]);
      if (cross?.tileId === tile.id && cross.key === key) {
        setCross(pageId, undefined);
        return;
      }
      const parts = markFilters(ws.spec, result, ri);
      setCross(pageId, {
        tileId: tile.id,
        key,
        label: parts.map((p) => p.label).join(', '),
        filters: parts.map((p) => ({ id: newId('cf'), kind: 'values', field: p.item.field, dateLevel: p.item.dateLevel, values: [p.value] }))
      });
    },
    [ws, cross, tile.id, pageId, setCross]
  );

  return (
    <div className={`tile${isSource ? ' source' : ''}`} data-testid={`tile-${tile.kind}`} data-title={title}>
      {tile.kind !== 'text' && (
        <div className="tile-head">
          <span className="tile-title drag-handle" title="Drag to move">
            {title}
          </span>
          {tile.kind === 'worksheet' && ws && (
            <button className="small ghost" onClick={() => go('worksheet', ws.id)} title="Edit worksheet">
              ✎
            </button>
          )}
          <button className="small ghost" onClick={onRemove} aria-label="Remove tile">
            ✕
          </button>
        </div>
      )}
      <div className="tile-body">
        {tile.kind === 'worksheet' &&
          (ws ? (
            <div style={{ position: 'absolute', inset: 6 }}>
              <ViewChart spec={ws.spec} externalFilters={external} selectedKey={isSource ? cross?.key : undefined} onMarkClick={onMarkClick} compact />
            </div>
          ) : (
            <div className="empty">This worksheet was deleted.</div>
          ))}
        {tile.kind === 'text' &&
          (editingText ? (
            <textarea
              className="tile-text-edit"
              autoFocus
              defaultValue={tile.text}
              onBlur={(e) => {
                const text = e.target.value;
                editPage((p) => {
                  const t = p.tiles.find((x) => x.id === tile.id);
                  if (t && t.kind === 'text') t.text = text;
                });
                setEditingText(false);
              }}
            />
          ) : (
            <div className="tile-text drag-handle" onDoubleClick={() => setEditingText(true)} title="Double-click to edit, drag to move">
              {tile.text.split('\n').map((line, i) => (
                <div key={i} className={line.startsWith('# ') ? 'h1' : ''}>
                  {line.startsWith('# ') ? line.slice(2) : line || ' '}
                </div>
              ))}
            </div>
          ))}
        {tile.kind === 'text' && !editingText && (
          <button className="small ghost" style={{ position: 'absolute', top: 4, right: 4 }} onClick={onRemove} aria-label="Remove tile">
            ✕
          </button>
        )}
        {tile.kind === 'slicer' && (
          <Slicer
            tile={tile}
            onChange={(state) =>
              editPage((p) => {
                const t = p.tiles.find((x) => x.id === tile.id);
                if (t && t.kind === 'slicer') t.state = state;
              })
            }
          />
        )}
      </div>
    </div>
  );
}

function Slicer({ tile, onChange }: { tile: Extract<Tile, { kind: 'slicer' }>; onChange: (s: SlicerState | undefined) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const info = fieldInfo(model, tile.field);
  const spec: VizSpec = useMemo(
    () =>
      tile.slicerType === 'list'
        ? { chartType: 'table', columns: [{ id: 'v', field: tile.field, role: 'dimension' }], rows: [], tooltip: [], filters: [] }
        : {
            chartType: 'kpi',
            columns: [],
            rows: [
              { id: 'lo', field: tile.field, role: 'measure', agg: 'MIN' },
              { id: 'hi', field: tile.field, role: 'measure', agg: 'MAX' }
            ],
            tooltip: [],
            filters: []
          },
    [tile.field, tile.slicerType]
  );
  const q = useVizQuery(model, spec, undefined, 2000);
  const st = tile.state ?? {};
  if (q.error) return <div className="banner error">{q.error}</div>;
  if (!q.result) return <div className="slicer muted">Loading…</div>;

  if (tile.slicerType === 'list') {
    const selected = new Set((st.values ?? []).map((v) => JSON.stringify(v)));
    const toggle = (v: Scalar): void => {
      const k = JSON.stringify(v);
      const next = (st.values ?? []).filter((x) => JSON.stringify(x) !== k);
      if (!selected.has(k)) next.push(v);
      onChange(next.length ? { values: next } : undefined);
    };
    return (
      <div className="slicer" data-testid="slicer-list">
        <div className="row">
          <span className="muted grow">{selected.size ? `${selected.size} selected` : 'All'}</span>
          {selected.size > 0 && (
            <button className="small ghost" onClick={() => onChange(undefined)}>
              Clear
            </button>
          )}
        </div>
        {q.result.rows.map(([v]) => (
          <label className="opt" key={JSON.stringify(v)}>
            <input type="checkbox" checked={selected.has(JSON.stringify(v))} onChange={() => toggle(v)} />
            {formatValue(v, info?.dataType ?? 'string')}
          </label>
        ))}
        {q.result.truncated && <span className="faint">Only the first {q.result.limit} values are listed.</span>}
      </div>
    );
  }

  const [lo, hi] = q.result.rows[0] ?? [null, null];
  const date = tile.slicerType === 'dateRange';
  const val = (v: Scalar | undefined): string => (v === undefined || v === null ? '' : String(v).slice(0, date ? 10 : undefined));
  const set = (key: 'min' | 'max', v: string): void => {
    const next: SlicerState = { ...st, [key]: v === '' ? undefined : date ? v : Number(v) };
    onChange(next.min === undefined && next.max === undefined ? undefined : next);
  };
  return (
    <div className="slicer" data-testid={`slicer-${tile.slicerType}`}>
      <div className="range">
        <label className="col" style={{ gap: 2 }}>
          <span className="muted">From</span>
          <input
            aria-label="From"
            type={date ? 'date' : 'number'}
            value={val(st.min)}
            placeholder={val(lo)}
            min={date ? val(lo) : undefined}
            max={date ? val(hi) : undefined}
            onChange={(e) => set('min', e.target.value)}
          />
        </label>
        <label className="col" style={{ gap: 2 }}>
          <span className="muted">To</span>
          <input
            aria-label="To"
            type={date ? 'date' : 'number'}
            value={val(st.max)}
            placeholder={val(hi)}
            min={date ? val(lo) : undefined}
            max={date ? val(hi) : undefined}
            onChange={(e) => set('max', e.target.value)}
          />
        </label>
      </div>
      <div className="row">
        <span className="faint grow">
          {formatValue(lo, info?.dataType ?? 'string')} to {formatValue(hi, info?.dataType ?? 'string')}
        </span>
        {(st.min !== undefined || st.max !== undefined) && (
          <button className="small ghost" onClick={() => onChange(undefined)}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function SlicerDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (field: FieldRef, t: SlicerType) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const fields = listFields(model).filter((f) => f.calcKind !== 'measure' && !f.error);
  const [key, setKey] = useState(fields[0]?.key ?? '');
  const f = fields.find((x) => x.key === key);
  const auto: SlicerType = isTemporal(f) ? 'dateRange' : f?.vtype === 'number' ? 'numericRange' : 'list';
  const [type, setType] = useState<SlicerType | null>(null);
  const t = type ?? auto;
  return (
    <Modal
      title="Add a slicer"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!f} onClick={() => f && (onAdd(f.ref, t), onClose())}>
            Add slicer
          </button>
        </>
      }
    >
      <div className="col">
        <label className="col" style={{ gap: 4 }}>
          Field
          <select aria-label="Slicer field" value={key} onChange={(e) => (setKey(e.target.value), setType(null))}>
            {fields.map((x) => (
              <option key={x.key} value={x.key}>
                {x.tableName ? `${x.tableName}.` : ''}
                {x.name}
              </option>
            ))}
          </select>
        </label>
        <label className="col" style={{ gap: 4 }}>
          Type
          <select aria-label="Slicer type" value={t} onChange={(e) => setType(e.target.value as SlicerType)}>
            <option value="list">List of values</option>
            <option value="dateRange" disabled={!isTemporal(f)}>
              Date range
            </option>
            <option value="numericRange" disabled={f?.vtype !== 'number'}>
              Numeric range
            </option>
          </select>
        </label>
        <p className="muted" style={{ margin: 0 }}>
          A slicer filters every worksheet on this page that can reach its table through relationships.
        </p>
      </div>
    </Modal>
  );
}
