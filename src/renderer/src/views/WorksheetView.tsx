import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent
} from '@dnd-kit/core';
import { useMemo, useRef, useState } from 'react';
import { itemLabel } from '@shared/compiler/compile';
import { CHART_LABELS, chartFits, recommendCharts, resolveChartType, viewShape } from '@shared/recommend/recommend';
import {
  CHART_TYPES,
  DATE_LEVELS,
  type AggFn,
  type DateLevel,
  type FieldRef,
  type FilterDef,
  type NumberFormat,
  type ShelfItem,
  type VizSpec
} from '@shared/types';
import type { ChartHandle } from '../chart/Chart';
import { ChartIcon } from '../chart/icons';
import { FilterDialog, filterSummary } from '../components/FilterDialog';
import { FormulaEditor } from '../components/FormulaEditor';
import { MenuItem, MenuSep, MenuTitle, Popover } from '../components/Popover';
import { ViewChart } from '../components/ViewChart';
import { defaultAggFor, fieldInfo, isAggregateCalc, isTemporal, listFields, type FieldInfo } from '../fields';
import { newId } from '../ids';
import { useStore, useWorksheet } from '../store';

type ShelfName = 'columns' | 'rows' | 'color' | 'size' | 'label' | 'tooltip';
const SINGLE: ShelfName[] = ['color', 'size', 'label'];
const SHELF_LABEL: Record<ShelfName | 'filters', string> = {
  columns: 'Columns',
  rows: 'Rows',
  color: 'Color',
  size: 'Size',
  label: 'Label',
  tooltip: 'Tooltip',
  filters: 'Filters'
};

function getShelf(spec: VizSpec, shelf: ShelfName): ShelfItem[] {
  if (shelf === 'columns' || shelf === 'rows' || shelf === 'tooltip') return spec[shelf];
  const v = spec[shelf];
  return v ? [v] : [];
}

function setShelf(spec: VizSpec, shelf: ShelfName, items: ShelfItem[]): void {
  if (shelf === 'columns' || shelf === 'rows' || shelf === 'tooltip') spec[shelf] = items;
  else if (items[0]) spec[shelf] = items[items.length - 1];
  else delete spec[shelf];
}

function removeItem(spec: VizSpec, id: string): void {
  for (const s of ['columns', 'rows', 'color', 'size', 'label', 'tooltip'] as ShelfName[])
    setShelf(
      spec,
      s,
      getShelf(spec, s).filter((i) => i.id !== id)
    );
  if (spec.sort?.itemId === id) delete spec.sort;
}

export function newItem(f: FieldInfo, role?: 'dimension' | 'measure'): ShelfItem {
  const r = role ?? f.role;
  const item: ShelfItem = { id: newId('i'), field: f.ref, role: isAggregateCalc(f) ? 'measure' : r };
  if (item.role === 'measure') item.agg = defaultAggFor(f);
  if (item.role === 'dimension' && isTemporal(f)) item.dateLevel = 'month';
  return item;
}

/** Double-click placement: dimensions go across, measures go up. */
function smartAdd(spec: VizSpec, f: FieldInfo): void {
  const item = newItem(f);
  if (item.role === 'dimension') {
    if (!spec.columns.some((i) => i.role === 'dimension')) spec.columns.push(item);
    else if (!spec.color) spec.color = item;
    else spec.rows.unshift(item);
  } else if (spec.rows.some((i) => i.role === 'dimension') && !spec.columns.some((i) => i.role === 'dimension')) spec.columns.push(item);
  else spec.rows.push(item);
}

export function WorksheetView(): React.JSX.Element {
  const id = useStore((s) => s.worksheetId);
  const ws = useWorksheet(id);
  if (!ws) return <div className="empty">Pick or create a worksheet in the sidebar.</div>;
  return <Worksheet key={ws.id} />;
}

type DragData = { kind: 'field'; field: FieldInfo } | { kind: 'pill'; shelf: ShelfName; item: ShelfItem };

function Worksheet(): React.JSX.Element {
  const id = useStore((s) => s.worksheetId) as string;
  const ws = useWorksheet(id);
  const model = useStore((s) => s.project.model);
  const update = useStore((s) => s.update);
  const toast = useStore((s) => s.toast);
  const chartRef = useRef<ChartHandle>(null);
  const [dragging, setDragging] = useState<DragData | null>(null);
  const [filterEdit, setFilterEdit] = useState<{ field: FieldRef; filter?: FilterDef } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  if (!ws) return <div />;
  const spec = ws.spec;

  const edit = (fn: (s: VizSpec) => void): void =>
    update((p) => {
      const w = p.worksheets.find((x) => x.id === id);
      if (w) fn(w.spec);
    });

  const onDragStart = (e: DragStartEvent): void => setDragging((e.active.data.current as DragData) ?? null);
  const onDragEnd = (e: DragEndEvent): void => {
    setDragging(null);
    const data = e.active.data.current as DragData | undefined;
    const target = e.over?.id ? String(e.over.id).replace(/^shelf:/, '') : null;
    if (!data) return;
    if (target === 'filters') {
      const ref = data.kind === 'field' ? data.field.ref : data.item.field;
      setFilterEdit({ field: ref });
      return;
    }
    if (!target) {
      if (data.kind === 'pill') edit((s) => removeItem(s, data.item.id));
      return;
    }
    const shelf = target as ShelfName;
    edit((s) => {
      let item: ShelfItem;
      if (data.kind === 'pill') {
        if (data.shelf === shelf) return;
        item = data.item;
        removeItem(s, item.id);
      } else {
        const asMeasure = shelf === 'size' ? 'measure' : undefined;
        item = newItem(data.field, asMeasure);
      }
      const items = getShelf(s, shelf);
      setShelf(s, shelf, SINGLE.includes(shelf) ? [item] : [...items, item]);
    });
  };

  const exportPng = async (): Promise<void> => {
    const png = chartRef.current?.toPng();
    if (!png) return toast('info', 'PNG export works for charts. Use Export CSV for tables and KPI cards.');
    const path = await window.facet.exportPng(png, ws.name);
    if (path) toast('info', `Saved ${path}`);
  };
  const exportCsv = async (): Promise<void> => {
    try {
      const path = await window.facet.exportCsv({ requestId: newId('x'), model, spec }, ws.name);
      if (path) toast('info', `Saved ${path}`);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  const measures = [...spec.columns, ...spec.rows].filter((i) => i.role === 'measure');

  return (
    <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
      <div className="view">
        <div className="view-header">
          <SheetName id={id} name={ws.name} />
          <span className="spacer" />
          <button
            title="Sort by the first measure, descending"
            disabled={measures.length === 0}
            onClick={() => edit((s) => (s.sort = { itemId: measures[0].id, dir: s.sort?.dir === 'desc' && s.sort.itemId === measures[0].id ? 'asc' : 'desc' }))}
          >
            Sort {spec.sort ? (spec.sort.dir === 'desc' ? '↓' : '↑') : '↕'}
          </button>
          <button disabled={!spec.sort} onClick={() => edit((s) => delete s.sort)}>
            Clear sort
          </button>
          <button onClick={() => edit((s) => Object.assign(s, { columns: s.rows, rows: s.columns }))} title="Swap rows and columns">
            Swap
          </button>
          <button onClick={() => void exportPng()}>Export PNG</button>
          <button onClick={() => void exportCsv()}>Export CSV</button>
          <button
            className="danger"
            onClick={() =>
              edit((s) =>
                Object.assign(s, { columns: [], rows: [], tooltip: [], filters: [], color: undefined, size: undefined, label: undefined, sort: undefined })
              )
            }
          >
            Clear
          </button>
        </div>
        <div className="ws-layout view-body" style={{ overflow: 'hidden' }}>
          <FieldsPane onAdd={(f) => edit((s) => smartAdd(s, f))} />
          <div className="ws-center">
            <div className="shelves">
              <Shelf name="columns" spec={spec} edit={edit} />
              <Shelf name="rows" spec={spec} edit={edit} />
              <FilterShelf spec={spec} edit={edit} onEdit={(f) => setFilterEdit({ field: f.field, filter: f })} />
            </div>
            <div className="chart-area">
              <ViewChart ref={chartRef} spec={spec} />
            </div>
          </div>
          <aside className="side-pane">
            <ChartTypes spec={spec} edit={edit} />
            <div className="col" style={{ gap: 6 }}>
              <h3>Marks</h3>
              <Shelf name="color" spec={spec} edit={edit} vertical />
              <Shelf name="size" spec={spec} edit={edit} vertical />
              <Shelf name="label" spec={spec} edit={edit} vertical />
              <Shelf name="tooltip" spec={spec} edit={edit} vertical />
            </div>
          </aside>
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && (
          <div className={`pill drag-overlay ${dragging.kind === 'field' ? dragging.field.role : dragging.item.role}`}>
            <span className="pill-text">{dragging.kind === 'field' ? dragging.field.name : itemLabel(dragging.item, model)}</span>
          </div>
        )}
      </DragOverlay>
      {filterEdit && (
        <FilterDialog
          field={filterEdit.field}
          filter={filterEdit.filter}
          onClose={() => setFilterEdit(null)}
          onSave={(f) =>
            edit((s) => {
              const i = s.filters.findIndex((x) => x.id === f.id);
              if (i >= 0) s.filters[i] = f;
              else s.filters.push(f);
            })
          }
        />
      )}
    </DndContext>
  );
}

function SheetName({ id, name }: { id: string; name: string }): React.JSX.Element {
  const update = useStore((s) => s.update);
  const [v, setV] = useState(name);
  return (
    <input
      aria-label="Worksheet name"
      className="project-name"
      style={{ fontSize: 15 }}
      value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() =>
        v.trim() && v !== name
          ? update((p) => {
              const w = p.worksheets.find((x) => x.id === id);
              if (w) w.name = v.trim();
            })
          : setV(name)
      }
    />
  );
}

function FieldsPane({ onAdd }: { onAdd: (f: FieldInfo) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const fields = useMemo(() => listFields(model), [model]);
  const match = (f: FieldInfo): boolean => !search || f.name.toLowerCase().includes(search.toLowerCase());
  const group = (role: 'dimension' | 'measure'): React.JSX.Element[] => {
    const out: React.JSX.Element[] = [];
    for (const t of model.tables) {
      const fs = fields.filter((f) => f.tableId === t.id && f.role === role && match(f));
      if (!fs.length) continue;
      if (model.tables.length > 1)
        out.push(
          <div key={`t${t.id}${role}`} className="field-group-title">
            {t.name}
          </div>
        );
      for (const f of fs) out.push(<Field key={f.key} f={f} onAdd={onAdd} />);
    }
    const calcs = fields.filter((f) => !f.tableId && f.role === role && match(f));
    if (calcs.length)
      out.push(
        <div key={`c${role}`} className="field-group-title">
          Calculations
        </div>
      );
    for (const f of calcs) out.push(<Field key={f.key} f={f} onAdd={onAdd} onEdit={() => f.ref.kind === 'calc' && setEditing(f.ref.id)} />);
    return out;
  };
  return (
    <aside className="fields-pane" data-testid="fields-pane">
      <input className="search" placeholder="Search fields" value={search} onChange={(e) => setSearch(e.target.value)} />
      <button onClick={() => setEditing('new')} disabled={model.tables.length === 0}>
        + New calculation
      </button>
      <h3 style={{ marginTop: 8 }}>Dimensions</h3>
      {group('dimension')}
      <h3 style={{ marginTop: 8 }}>Measures</h3>
      {group('measure')}
      {model.tables.length === 0 && <p className="muted">Import data to see its fields here.</p>}
      {editing && <FormulaEditor calc={editing === 'new' ? undefined : model.calcs.find((c) => c.id === editing)} onClose={() => setEditing(null)} />}
    </aside>
  );
}

function glyph(f: FieldInfo): string {
  if (f.ref.kind === 'calc') return '=';
  switch (f.vtype) {
    case 'number':
      return '#';
    case 'date':
    case 'datetime':
      return '◷';
    case 'boolean':
      return 'T|F';
    default:
      return 'Abc';
  }
}

function Field({ f, onAdd, onEdit }: { f: FieldInfo; onAdd: (f: FieldInfo) => void; onEdit?: () => void }): React.JSX.Element {
  const { setNodeRef, listeners, attributes } = useDraggable({ id: `field:${f.key}`, data: { kind: 'field', field: f } });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`field ${f.role}${f.error ? ' error' : ''}`}
      title={f.error ? `Error: ${f.error}` : `${f.name}${f.tableName ? ` (${f.tableName})` : ''}. Double-click to add, or drag to a shelf.`}
      onDoubleClick={() => onAdd(f)}
      data-testid={`field-${f.name}`}
    >
      <span className="glyph">{glyph(f)}</span>
      <span className="name">{f.name}</span>
      {onEdit && (
        <button className="small ghost" onPointerDown={(e) => e.stopPropagation()} onClick={onEdit} title="Edit calculation">
          ✎
        </button>
      )}
    </div>
  );
}

function Shelf({
  name,
  spec,
  edit,
  vertical
}: {
  name: ShelfName;
  spec: VizSpec;
  edit: (fn: (s: VizSpec) => void) => void;
  vertical?: boolean;
}): React.JSX.Element {
  const { setNodeRef, isOver } = useDroppable({ id: `shelf:${name}` });
  const items = getShelf(spec, name);
  return (
    <div ref={setNodeRef} className={`shelf${isOver ? ' over' : ''}`} data-testid={`shelf-${name}`} style={vertical ? { minHeight: 34 } : undefined}>
      <span className="shelf-label">{SHELF_LABEL[name]}</span>
      {items.map((i) => (
        <Pill key={i.id} shelf={name} item={i} spec={spec} edit={edit} />
      ))}
      {items.length === 0 && <span className="shelf-hint">Drop a field here</span>}
    </div>
  );
}

const AGG_LABELS: Record<AggFn, string> = {
  SUM: 'Sum',
  AVG: 'Average',
  MIN: 'Minimum',
  MAX: 'Maximum',
  COUNT: 'Count',
  COUNTD: 'Distinct count',
  MEDIAN: 'Median'
};
const LEVEL_LABELS: Record<DateLevel, string> = { year: 'Year', quarter: 'Quarter', month: 'Month', week: 'Week', day: 'Day' };
const FORMATS: { label: string; f: NumberFormat | undefined }[] = [
  { label: 'Automatic', f: undefined },
  { label: 'Number (0 decimals)', f: { style: 'number', decimals: 0 } },
  { label: 'Number (2 decimals)', f: { style: 'number', decimals: 2 } },
  { label: 'Percent', f: { style: 'percent', decimals: 1 } },
  { label: 'Currency (USD)', f: { style: 'currency', currency: 'USD' } },
  { label: 'Currency (EUR)', f: { style: 'currency', currency: 'EUR' } },
  { label: 'Compact (1.2K)', f: { style: 'compact' } }
];

function Pill({ shelf, item, spec, edit }: { shelf: ShelfName; item: ShelfItem; spec: VizSpec; edit: (fn: (s: VizSpec) => void) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const { setNodeRef, listeners, attributes, isDragging } = useDraggable({ id: `pill:${shelf}:${item.id}`, data: { kind: 'pill', shelf, item } });
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const info = fieldInfo(model, item.field);
  const temporal = isTemporal(info) && item.role === 'dimension';
  const label = itemLabel(item, model);
  const set = (fn: (i: ShelfItem) => void): void => {
    edit((s) => {
      const target = getShelf(s, shelf).find((i) => i.id === item.id);
      if (target) fn(target);
    });
    setMenu(null);
  };
  const levelIdx = item.dateLevel ? DATE_LEVELS.indexOf(item.dateLevel) : DATE_LEVELS.length;
  return (
    <span
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`pill ${item.role}${info ? '' : ' error'}`}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      data-testid="pill"
      title={info?.error ?? label}
    >
      <span className="pill-text">{info ? label : `Missing field: ${label}`}</span>
      {spec.sort?.itemId === item.id && <span>{spec.sort.dir === 'desc' ? '↓' : '↑'}</span>}
      {temporal && levelIdx > 0 && (
        <button
          title="Drill up"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => set((i) => (i.dateLevel = DATE_LEVELS[Math.min(levelIdx, DATE_LEVELS.length) - 1]))}
        >
          −
        </button>
      )}
      {temporal && levelIdx < DATE_LEVELS.length - 1 && (
        <button title="Drill down" onPointerDown={(e) => e.stopPropagation()} onClick={() => set((i) => (i.dateLevel = DATE_LEVELS[levelIdx + 1]))}>
          +
        </button>
      )}
      <button aria-label="Field options" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => setMenu(menu ? null : (e.currentTarget as HTMLElement))}>
        ▾
      </button>
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          {!isAggregateCalc(info) && (
            <>
              <MenuItem
                checked={item.role === 'dimension'}
                onClick={() => set((i) => ((i.role = 'dimension'), delete i.agg, temporal || (isTemporal(info) && (i.dateLevel = 'month'))))}
              >
                Dimension
              </MenuItem>
              <MenuItem
                checked={item.role === 'measure'}
                onClick={() => set((i) => ((i.role = 'measure'), (i.agg = i.agg ?? defaultAggFor(info)), delete i.dateLevel))}
              >
                Measure
              </MenuItem>
              <MenuSep />
            </>
          )}
          {item.role === 'measure' && !isAggregateCalc(info) && (
            <>
              <MenuTitle>Aggregation</MenuTitle>
              {(Object.keys(AGG_LABELS) as AggFn[])
                .filter((a) => info?.vtype === 'number' || !['SUM', 'AVG', 'MEDIAN'].includes(a))
                .map((a) => (
                  <MenuItem key={a} checked={item.agg === a} onClick={() => set((i) => (i.agg = a))}>
                    {AGG_LABELS[a]}
                  </MenuItem>
                ))}
              <MenuSep />
            </>
          )}
          {temporal && (
            <>
              <MenuTitle>Date level</MenuTitle>
              {DATE_LEVELS.map((l) => (
                <MenuItem key={l} checked={item.dateLevel === l} onClick={() => set((i) => (i.dateLevel = l))}>
                  {LEVEL_LABELS[l]}
                </MenuItem>
              ))}
              <MenuItem checked={!item.dateLevel} onClick={() => set((i) => delete i.dateLevel)}>
                Exact date
              </MenuItem>
              <MenuSep />
            </>
          )}
          {item.role === 'measure' && (
            <>
              <MenuTitle>Number format</MenuTitle>
              {FORMATS.map((f) => (
                <MenuItem
                  key={f.label}
                  checked={JSON.stringify(item.format) === JSON.stringify(f.f)}
                  onClick={() => set((i) => (f.f ? (i.format = f.f) : delete i.format))}
                >
                  {f.label}
                </MenuItem>
              ))}
              <MenuSep />
            </>
          )}
          <MenuItem onClick={() => (edit((s) => (s.sort = { itemId: item.id, dir: 'asc' })), setMenu(null))}>Sort ascending</MenuItem>
          <MenuItem onClick={() => (edit((s) => (s.sort = { itemId: item.id, dir: 'desc' })), setMenu(null))}>Sort descending</MenuItem>
          <MenuSep />
          <MenuItem onClick={() => (edit((s) => removeItem(s, item.id)), setMenu(null))}>Remove</MenuItem>
        </Popover>
      )}
    </span>
  );
}

function FilterShelf({ spec, edit, onEdit }: { spec: VizSpec; edit: (fn: (s: VizSpec) => void) => void; onEdit: (f: FilterDef) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const { setNodeRef, isOver } = useDroppable({ id: 'shelf:filters' });
  return (
    <div ref={setNodeRef} className={`shelf${isOver ? ' over' : ''}`} data-testid="shelf-filters">
      <span className="shelf-label">Filters</span>
      {spec.filters.map((f) => (
        <span className="pill filter" key={f.id} data-testid="filter-pill">
          <span className="pill-text" onClick={() => onEdit(f)} style={{ cursor: 'pointer' }}>
            {f.context ? '◆ ' : ''}
            {filterSummary(f, itemLabel({ id: 'x', field: f.field, role: 'dimension' }, model))}
          </span>
          <button aria-label="Remove filter" onClick={() => edit((s) => (s.filters = s.filters.filter((x) => x.id !== f.id)))}>
            ✕
          </button>
        </span>
      ))}
      {spec.filters.length === 0 && <span className="shelf-hint">Drop a field here to filter</span>}
    </div>
  );
}

function ChartTypes({ spec, edit }: { spec: VizSpec; edit: (fn: (s: VizSpec) => void) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const shape = viewShape(spec, model);
  const recos = recommendCharts(shape);
  const current = resolveChartType(spec, model);
  const best = recos[0];
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row">
        <h3 className="grow">Chart</h3>
        <label className="row" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={spec.chartType === 'auto'} onChange={(e) => edit((s) => (s.chartType = e.target.checked ? 'auto' : current))} />
          Automatic
        </label>
      </div>
      <div className="chart-types">
        {CHART_TYPES.map((t) => (
          <button
            key={t}
            className={`chart-type${t === current ? ' active' : ''}${best?.type === t ? ' recommended' : ''}${chartFits(t, shape) ? '' : ' unfit'}`}
            title={chartFits(t, shape) ? (recos.find((r) => r.type === t)?.reason ?? CHART_LABELS[t]) : `${CHART_LABELS[t]} needs different fields`}
            onClick={() => edit((s) => (s.chartType = t))}
            data-testid={`chart-${t}`}
          >
            <ChartIcon type={t} />
            {CHART_LABELS[t]}
          </button>
        ))}
      </div>
      {best && shape.dims.length + shape.measures > 0 && (
        <div className="reco" data-testid="recommendation">
          Recommended: <b>{CHART_LABELS[best.type]}</b>. {best.reason}.
        </div>
      )}
    </div>
  );
}
