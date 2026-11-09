// Explore: a relationship graph of the values in your data, with ranked insights, a value's own
// story, and a timeline. See docs/EXPLORE.md.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadBase, loadWindow, visibleEdges, type Base, type GEdge, type GNode, type GraphData, type TimeWindow } from '@shared/explore/graph';
import { MAX_FIELDS } from '@shared/explore/graph';
import { explainNode, findInsights, type Insight } from '@shared/explore/insights';
import type { AggFn, Exploration, FieldRef, VizSpec } from '@shared/types';
import { Popover, MenuItem, MenuTitle } from '../components/Popover';
import { fieldKey, listFields } from '../fields';
import { GraphCanvas, type GraphStyle } from '../explore/GraphCanvas';
import { Timeline } from '../explore/Timeline';
import { fieldName, makeLabels, makeRunner, suggestExploration } from '../explore/data';
import { newId } from '../ids';
import { useStore } from '../store';

const PALETTE = {
  light: ['#2f6fdf', '#e8833a', '#2b9a74', '#d64f6b', '#8a63d2', '#c9a227'],
  dark: ['#5b93f5', '#f39a55', '#4fc39f', '#ee7088', '#a98bf0', '#e0bb44']
};

const KIND_LABEL: Record<Insight['kind'], string> = {
  hiddenLink: 'Hidden link',
  avoidedPair: 'Avoided pair',
  mover: 'Mover',
  shiftingLink: 'Shifting link',
  outlier: 'Outlier',
  spike: 'Spike or dip',
  concentration: 'Concentration',
  structure: 'Structure'
};

export function ExploreView(): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const stored = useStore((s) => s.project.explorations);
  const explorations = useMemo(() => stored ?? [], [stored]);
  const id = useStore((s) => s.explorationId);
  const update = useStore((s) => s.update);
  const go = useStore((s) => s.go);
  const e = explorations.find((x) => x.id === id) ?? explorations[0];
  const [suggesting, setSuggesting] = useState(false);
  const [noSuggestion, setNoSuggestion] = useState(false);

  // First visit: suggest an exploration from the data, so there is something to see straight away.
  useEffect(() => {
    if (e || suggesting || noSuggestion || !model.tables.length) return;
    setSuggesting(true);
    void suggestExploration(model)
      .then((x) => {
        if (!x) return setNoSuggestion(true);
        update((p) => void (p.explorations = [...(p.explorations ?? []), x]));
        go('explore', x.id);
      })
      .finally(() => setSuggesting(false));
  }, [e, suggesting, noSuggestion, model, update, go]);

  if (!model.tables.length) return <div className="empty">Import some data first. Explore then maps how its values connect.</div>;
  if (!e)
    return <div className="empty">{suggesting ? 'Looking for fields to explore…' : 'Add a text field to your data to explore how its values connect.'}</div>;
  return <Explorer key={e.id} e={e} />;
}

function Explorer({ e }: { e: Exploration }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const stored = useStore((s) => s.project.explorations);
  const explorations = useMemo(() => stored ?? [], [stored]);
  const theme = useStore((s) => s.theme);
  const dataVersion = useStore((s) => s.dataVersion);
  const update = useStore((s) => s.update);
  const go = useStore((s) => s.go);
  const toast = useStore((s) => s.toast);

  const edit = useCallback(
    (fn: (x: Exploration) => void) =>
      update((p) => {
        const x = p.explorations?.find((y) => y.id === e.id);
        if (x) fn(x);
      }),
    [update, e.id]
  );

  // Base: values and series (depends on the fields, measure and time, not on the window or styling).
  const baseKey = JSON.stringify([e.fields, e.measure, e.time ?? null, e.topN, model, dataVersion]);
  const [base, setBase] = useState<Base | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [win, setWin] = useState<TimeWindow | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(false);
  const [timing, setTiming] = useState<{ base?: number; window?: number; loads?: number }>({});
  const runner = useMemo(() => makeRunner(model, dataVersion), [model, dataVersion]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    loadBase(e, runner)
      .then((b) => {
        if (!alive) return;
        setBase(b);
        setTiming((t) => ({ ...t, base: performance.now() - t0 }));
        const n = b.periods.length;
        // Start on the latest quarter of the range, compared with the quarter before, so change shows at once.
        setWin(n >= 8 ? { from: n - Math.ceil(n / 4), to: n - 1 } : n ? { from: 0, to: n - 1 } : null);
      })
      .catch((err: Error) => alive && (setError(err.message), setLoading(false)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey]);

  // Window: links for the window and the one before it. Debounced while dragging.
  useEffect(() => {
    if (!base) return;
    let alive = true;
    const t = setTimeout(() => {
      const t0 = performance.now();
      setLoading(true);
      loadWindow(e, base, runner, win)
        .then((g) => {
          if (!alive) return;
          setGraph(g);
          setTiming((x) => ({ ...x, window: performance.now() - t0, loads: (x.loads ?? 0) + 1 }));
          setLoading(false);
        })
        .catch((err: Error) => alive && (setError(err.message), setLoading(false)));
    }, 60);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, win?.from, win?.to]);

  const labels = useMemo(() => makeLabels(model, e, base?.level ?? null), [model, e, base?.level]);
  const insights = useMemo(() => (graph ? findInsights(graph, labels) : []), [graph, labels]);
  const shown = useMemo(() => (graph ? visibleEdges(graph, e.links) : []), [graph, e.links]);
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<Insight | null>(null);
  const [flyTo, setFlyTo] = useState<{ id: string; seq: number } | null>(null);
  const seq = useRef(0);
  const fly = (nodeId: string): void => setFlyTo({ id: nodeId, seq: ++seq.current });

  // Insight links must be drawn even when the link filter would hide them.
  const drawn = useMemo(() => {
    if (!graph || !active?.edges.length) return shown;
    const ids = new Set(shown.map((x) => x.id));
    return [...shown, ...graph.edges.filter((x) => active.edges.includes(x.id) && !ids.has(x.id))];
  }, [graph, shown, active]);

  const palette = PALETTE[theme === 'dark' ? 'dark' : 'light'];
  const graphStyle: GraphStyle = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const text = css.getPropertyValue('--text').trim() || '#1d2330';
    const faded = theme === 'dark' ? '#3a404c' : '#dfe2e8';
    const change = (n: GNode): string => {
      if (n.mPrev === undefined) return theme === 'dark' ? '#79818f' : '#8b93a1';
      const d = n.mPrev > 0 ? (n.m - n.mPrev) / n.mPrev : n.m > 0 ? 1 : 0;
      const k = Math.min(1, Math.abs(d) / 0.6);
      const mix = (a: number[], b: number[]): string => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
      const grey = theme === 'dark' ? [121, 129, 143] : [160, 166, 176];
      return d >= 0 ? mix(grey, [43, 154, 116]) : mix(grey, [214, 79, 107]);
    };
    return {
      text,
      faded,
      nodeColor: (n) => (e.colorBy === 'change' ? change(n) : palette[n.field % palette.length]),
      label: (n) => {
        const base = labels.node(n);
        if (e.colorBy !== 'change' || n.mPrev === undefined || n.mPrev <= 0) return base;
        const d = (n.m - n.mPrev) / n.mPrev;
        return `${base} ${d >= 0 ? '▲' : '▼'}${Math.abs(d * 100).toFixed(0)}%`;
      },
      edgeColor: (x: GEdge) =>
        x.lift >= 1.25
          ? theme === 'dark'
            ? '#5b93f5aa'
            : '#2f6fdf99'
          : x.lift <= 0.8
            ? theme === 'dark'
              ? '#ee708899'
              : '#d64f6b88'
            : theme === 'dark'
              ? '#8f9aab55'
              : '#9aa3b155'
    };
  }, [e.colorBy, palette, labels, theme]);

  const highlight = useMemo(() => (active ? { nodes: new Set(active.nodes), edges: new Set(active.edges) } : null), [active]);
  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const selectedNode = selected ? byId.get(selected) : undefined;

  const [search, setSearch] = useState('');
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q || !graph) return [];
    return graph.nodes.filter((n) => labels.node(n).toLowerCase().includes(q)).slice(0, 8);
  }, [search, graph, labels]);

  const openWorksheet = (n: GNode): void => {
    const spec: VizSpec = {
      chartType: e.time ? 'line' : 'bar',
      columns: e.time
        ? [{ id: newId('i'), field: e.time, role: 'dimension', dateLevel: base?.level === 'day' || base?.level === 'week' ? 'week' : 'month' }]
        : [],
      rows: [{ id: newId('i'), field: e.measure.field, role: 'measure', agg: e.measure.agg }],
      tooltip: [],
      filters: [{ id: newId('f'), kind: 'values', field: e.fields[n.field], values: [n.value] }]
    };
    const w = { id: newId('w'), name: `${labels.node(n)} over time`, spec };
    update((p) => void p.worksheets.push(w));
    go('worksheet', w.id);
    toast('info', `Created the worksheet "${w.name}".`);
  };

  return (
    <div className="view explore">
      <ExploreHeader e={e} explorations={explorations} edit={edit} search={search} setSearch={setSearch} />
      {matches.length > 0 && (
        <div className="explore-matches" data-testid="search-results">
          {matches.map((n) => (
            <button
              key={n.id}
              className="small"
              onClick={() => {
                setSelected(n.id);
                setActive(null);
                fly(n.id);
                setSearch('');
              }}
            >
              <span className="swatch" style={{ background: palette[n.field % palette.length] }} />
              {labels.node(n)} <span className="faint">{labels.field(n.field)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="explore-body">
        <div className="explore-main">
          {error && <div className="banner error">{error}</div>}
          {graph && (
            <GraphCanvas
              data={graph}
              edges={drawn}
              style={graphStyle}
              selected={selected}
              highlight={highlight}
              flyTo={flyTo}
              onSelect={(nid) => {
                setSelected(nid);
                setActive(null);
              }}
            />
          )}
          {!graph && !error && <div className="empty">Mapping how your values connect…</div>}
          <div className="explore-legend">
            {e.fields.map((f, i) => (
              <span key={fieldKey(f) + i} className="row">
                <span
                  className="swatch"
                  style={{ background: e.colorBy === 'change' ? 'transparent' : palette[i % palette.length], borderColor: palette[i % palette.length] }}
                />
                {fieldName(model, f)}
              </span>
            ))}
            <span className="faint">
              Size: {e.measure.agg.toLowerCase()} of {fieldName(model, e.measure.field)} ·{' '}
              <span style={{ color: theme === 'dark' ? '#5b93f5' : '#2f6fdf' }}>blue</span> links occur more than expected,{' '}
              <span style={{ color: theme === 'dark' ? '#ee7088' : '#d64f6b' }}>red</span> less
            </span>
          </div>
          <div className="explore-status faint" data-testid="explore-status" data-loads={timing.loads ?? 0}>
            {loading ? 'Updating…' : graph ? `${graph.nodes.length} values, ${drawn.length} of ${graph.edges.length} links shown` : ''}
            {timing.window !== undefined && !loading ? ` · ${Math.round(timing.window)} ms` : ''}
          </div>
        </div>
        <aside className="explore-side">
          {selectedNode && graph ? (
            <NodePanel
              n={selectedNode}
              g={graph}
              labels={labels}
              e={e}
              onClose={() => setSelected(null)}
              onPick={(nid) => {
                setSelected(nid);
                fly(nid);
              }}
              onWorksheet={() => openWorksheet(selectedNode)}
            />
          ) : (
            <InsightList
              insights={insights}
              active={active}
              onPick={(i) => {
                setActive(active?.id === i.id ? null : i);
                setSelected(null);
                if (i.nodes[0]) fly(i.nodes[0]);
              }}
            />
          )}
        </aside>
      </div>
      {base && base.periods.length > 1 && win && (
        <Timeline
          periods={base.periods}
          values={base.overall}
          window={win}
          prev={graph?.prevWindow ?? null}
          mark={active?.period ?? null}
          unit={base.level ?? 'period'}
          label={(p) => labels.period(p).replace(/^the week of /, '')}
          onChange={setWin}
        />
      )}
    </div>
  );
}

function InsightList({ insights, active, onPick }: { insights: Insight[]; active: Insight | null; onPick(i: Insight): void }): React.JSX.Element {
  return (
    <div className="col" style={{ gap: 6 }} data-testid="insights">
      <h3>Insights</h3>
      <p className="faint" style={{ margin: 0 }}>
        Ranked by how far each finding is from what you would expect, and how much of the total it involves. Click one to see it in the graph.
      </p>
      {insights.length === 0 && <p className="muted">Nothing stands out in this window. Try a longer window or more values.</p>}
      {insights.map((i) => (
        <button key={i.id} className={`insight${active?.id === i.id ? ' active' : ''}`} onClick={() => onPick(i)} data-testid="insight" data-kind={i.kind}>
          <span className={`insight-kind k-${i.kind}`}>{KIND_LABEL[i.kind]}</span>
          <span className="insight-title">{i.title}</span>
          <span className="insight-detail">{i.detail}</span>
        </button>
      ))}
    </div>
  );
}

function Sparkline({ series, window: w, prev }: { series: number[]; window: TimeWindow | null; prev: TimeWindow | null }): React.JSX.Element | null {
  if (series.length < 2) return null;
  const max = Math.max(1e-9, ...series);
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * 100},${30 - (v / max) * 28}`).join(' ');
  const x = (i: number): number => (i / (series.length - 1)) * 100;
  return (
    <svg className="sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-label="Over time">
      {prev && <rect x={x(prev.from)} y={0} width={Math.max(0.5, x(prev.to) - x(prev.from))} height={30} className="timeline-prev" />}
      {w && <rect x={x(w.from)} y={0} width={Math.max(0.5, x(w.to) - x(w.from))} height={30} className="timeline-window" />}
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function NodePanel({
  n,
  g,
  labels,
  e,
  onClose,
  onPick,
  onWorksheet
}: {
  n: GNode;
  g: GraphData;
  labels: ReturnType<typeof makeLabels>;
  e: Exploration;
  onClose(): void;
  onPick(id: string): void;
  onWorksheet(): void;
}): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const groups = useMemo(() => explainNode(g, n.id), [g, n.id]);
  const share = g.total > 0 ? n.m / g.total : 0;
  const change = n.mPrev !== undefined && n.mPrev > 0 ? (n.m - n.mPrev) / n.mPrev : null;
  const pct = (v: number): string => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
  return (
    <div className="col" style={{ gap: 10 }} data-testid="node-panel">
      <div className="row">
        <button className="small ghost" onClick={onClose}>
          ← Insights
        </button>
        <span className="grow" />
        <button className="small" onClick={onWorksheet} title="Create a worksheet with this value's trend">
          Open in worksheet
        </button>
      </div>
      <div>
        <div className="faint">{labels.field(n.field)}</div>
        <h2 style={{ margin: '2px 0', wordBreak: 'break-word' }} data-testid="node-title">
          {labels.node(n)}
        </h2>
      </div>
      <dl className="stat-grid">
        <dt>{`${e.measure.agg.toLowerCase()} of ${fieldName(model, e.measure.field)}`}</dt>
        <dd data-testid="node-amount">{labels.amount(n.m)}</dd>
        <dt>Share of total</dt>
        <dd>{pct(share)}</dd>
        {change !== null && (
          <>
            <dt>Change</dt>
            <dd style={{ color: change >= 0 ? 'var(--dim)' : 'var(--danger)' }}>
              {change >= 0 ? '▲' : '▼'} {pct(Math.abs(change))} ({labels.amount(n.mPrev ?? 0)} before)
            </dd>
          </>
        )}
      </dl>
      <Sparkline series={n.series} window={g.window} prev={g.prevWindow} />
      <div className="col" style={{ gap: 6 }} data-testid="drivers">
        <h3>What makes it different</h3>
        {groups.every((x) => !x.over.length && !x.under.length) && <p className="muted">It goes with other values about as much as everything else does.</p>}
        {groups.map((grp) => {
          const ds = [...grp.over, ...grp.under];
          if (!ds.length) return null;
          // Bars are scaled within the group, so small shares are still readable.
          const top = Math.max(1e-9, ...ds.flatMap((d) => [d.within, d.overall]));
          return (
            <div key={grp.field} className="col" style={{ gap: 3 }}>
              <span className="faint">{labels.field(grp.field)}</span>
              {ds.map((d) => (
                <button
                  key={d.node.id}
                  className={`driver${d.lift < 1 ? ' under' : ''}`}
                  onClick={() => onPick(d.node.id)}
                  title={`${pct(d.within)} of ${labels.node(n)}, against ${pct(d.overall)} of everything`}
                >
                  <span className="grow">{labels.node(d.node)}</span>
                  <span className="driver-bar">
                    <span className="all" style={{ width: `${(d.overall / top) * 100}%` }} />
                    <span className="this" style={{ width: `${(d.within / top) * 100}%` }} />
                  </span>
                  {/* Nearly all of it in one value is belonging (a city in its region), not a surprise. */}
                  <b>{d.within >= 0.95 ? 'belongs to' : `${d.lift.toFixed(1)}×`}</b>
                </button>
              ))}
            </div>
          );
        })}
        <p className="faint" style={{ margin: 0 }}>
          Bars: this value (dark) against everything (light). The number is how many times more often they go together than expected.
        </p>
      </div>
    </div>
  );
}

function ExploreHeader({
  e,
  explorations,
  edit,
  search,
  setSearch
}: {
  e: Exploration;
  explorations: Exploration[];
  edit(fn: (x: Exploration) => void): void;
  search: string;
  setSearch(s: string): void;
}): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const update = useStore((s) => s.update);
  const go = useStore((s) => s.go);
  const fields = useMemo(() => listFields(model).filter((f) => !f.error), [model]);
  const dims = fields.filter((f) => f.role === 'dimension' && f.dataType !== 'date' && f.dataType !== 'datetime');
  const measures = fields.filter((f) => f.role === 'measure' && (f.dataType === 'integer' || f.dataType === 'number' || f.calcKind === 'measure'));
  const dates = fields.filter((f) => f.dataType === 'date' || f.dataType === 'datetime');
  const [adding, setAdding] = useState<HTMLElement | null>(null);
  const used = new Set(e.fields.map(fieldKey));
  const measureKey = `${e.measure.agg}|${fieldKey(e.measure.field)}`;
  const label = (f: { tableName?: string; name: string }): string => (model.tables.length > 1 && f.tableName ? `${f.tableName}.${f.name}` : f.name);
  // Sums of numeric fields, a row count, and the current choice if it is neither.
  const countKey = `COUNT|${fieldKey(e.fields[0])}`;
  const measureOptions = [
    ...measures.map((m) => ({ value: `SUM|${m.key}`, label: `Sum of ${label(m)}` })),
    { value: measureKey.startsWith('COUNT|') ? measureKey : countKey, label: 'Number of rows' }
  ];
  if (!measureOptions.some((o) => o.value === measureKey))
    measureOptions.push({ value: measureKey, label: `${e.measure.agg.toLowerCase()} of ${fieldName(model, e.measure.field)}` });

  return (
    <div className="view-header explore-header">
      <select
        aria-label="Exploration"
        value={e.id}
        onChange={(ev) => {
          if (ev.target.value === '__new') {
            const x: Exploration = { ...structuredClone(e), id: newId('x'), name: `Exploration ${explorations.length + 1}` };
            update((p) => void (p.explorations = [...(p.explorations ?? []), x]));
            go('explore', x.id);
          } else go('explore', ev.target.value);
        }}
      >
        {explorations.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
        <option value="__new">+ New exploration (copy)</option>
      </select>
      <span className="muted">Values of</span>
      <span className="row explore-fields" data-testid="explore-fields">
        {e.fields.map((f, i) => (
          <span key={fieldKey(f)} className="pill dimension">
            <span className="pill-text">{fieldName(model, f)}</span>
            {e.fields.length > 1 && (
              <button aria-label={`Remove ${fieldName(model, f)}`} onClick={() => edit((x) => void x.fields.splice(i, 1))}>
                ✕
              </button>
            )}
          </span>
        ))}
        {e.fields.length < MAX_FIELDS && (
          <button className="small" onClick={(ev) => setAdding(ev.currentTarget)} data-testid="add-explore-field">
            + Field
          </button>
        )}
      </span>
      <label className="row">
        <span className="muted">size by</span>
        <select
          aria-label="Size by"
          value={measureKey}
          onChange={(ev) => {
            const [agg, key] = ev.target.value.split(/\|(.*)/s);
            const f = fields.find((x) => x.key === key);
            if (f) edit((x) => void (x.measure = { field: f.ref, agg: agg as AggFn }));
          }}
        >
          {measureOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span className="muted">over</span>
        <select
          aria-label="Timeline field"
          value={e.time ? fieldKey(e.time) : ''}
          onChange={(ev) => {
            const f = dates.find((x) => x.key === ev.target.value);
            edit((x) => {
              if (f) x.time = f.ref;
              else delete x.time;
            });
          }}
        >
          <option value="">No timeline</option>
          {dates.map((d) => (
            <option key={d.key} value={d.key}>
              {label(d)}
            </option>
          ))}
        </select>
      </label>
      <label className="row">
        <span className="muted">top</span>
        <select aria-label="Values per field" value={e.topN} onChange={(ev) => edit((x) => void (x.topN = Number(ev.target.value)))}>
          {[10, 20, 30, 50, 100].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <span className="segmented" role="group" aria-label="Links to show">
        {(['surprising', 'both', 'strongest'] as const).map((m) => (
          <button key={m} className={e.links === m ? 'active' : ''} onClick={() => edit((x) => void (x.links = m))}>
            {m === 'surprising' ? 'Surprising' : m === 'strongest' ? 'Strongest' : 'Both'}
          </button>
        ))}
      </span>
      <span className="segmented" role="group" aria-label="Colour nodes by">
        {(['field', 'change'] as const).map((m) => (
          <button key={m} className={e.colorBy === m ? 'active' : ''} onClick={() => edit((x) => void (x.colorBy = m))} disabled={m === 'change' && !e.time}>
            {m === 'field' ? 'Colour: field' : 'Colour: change'}
          </button>
        ))}
      </span>
      <span className="grow" />
      <input className="explore-search" aria-label="Find a value" placeholder="Find a value…" value={search} onChange={(ev) => setSearch(ev.target.value)} />
      {adding && (
        <Popover anchor={adding} onClose={() => setAdding(null)}>
          <MenuTitle>Add a field</MenuTitle>
          {dims
            .filter((d) => !used.has(d.key))
            .map((d) => (
              <MenuItem
                key={d.key}
                onClick={() => {
                  edit((x) => void x.fields.push(d.ref as FieldRef));
                  setAdding(null);
                }}
              >
                {label(d)}
              </MenuItem>
            ))}
        </Popover>
      )}
    </div>
  );
}
