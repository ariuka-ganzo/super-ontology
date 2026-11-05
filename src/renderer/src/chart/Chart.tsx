import * as echarts from 'echarts';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import type { ChartType, QueryResult, Scalar, VizSpec } from '@shared/types';
import { bind, buildOption, DARK, fmt, LIGHT, rowKey, type Bound } from './options';
import { useStore } from '../store';

export interface ChartHandle {
  /** PNG data URL of the chart, or null for chart types drawn as HTML. */
  toPng(): string | null;
}

interface Props {
  type: ChartType;
  spec: VizSpec;
  result: QueryResult;
  selectedKey?: string;
  onMarkClick?: (rowIndex: number) => void;
  compact?: boolean;
}

export const Chart = forwardRef<ChartHandle, Props>(function Chart({ type, spec, result, selectedKey, onMarkClick, compact }, ref) {
  const themeName = useStore((s) => s.theme);
  const theme = themeName === 'dark' ? DARK : LIGHT;
  const el = useRef<HTMLDivElement>(null);
  const inst = useRef<echarts.ECharts | null>(null);
  const clickRef = useRef(onMarkClick);
  clickRef.current = onMarkClick;

  const option = useMemo(() => buildOption({ type, spec, result, theme, selectedKey, compact }), [type, spec, result, theme, selectedKey, compact]);

  // SVG keeps marks crisp and individually addressable; very large results use the faster canvas.
  const renderer: 'svg' | 'canvas' = result.rows.length <= 3000 ? 'svg' : 'canvas';

  useImperativeHandle(ref, () => ({
    toPng: () => {
      if (!option || !el.current) return null;
      // Render a canvas copy at the same size to export a PNG, whichever renderer is on screen.
      const host = document.createElement('div');
      host.style.cssText = `position:fixed;left:-10000px;top:0;width:${el.current.clientWidth}px;height:${el.current.clientHeight}px`;
      document.body.appendChild(host);
      const off = echarts.init(host, undefined, { renderer: 'canvas' });
      try {
        off.setOption({ ...option, animation: false });
        return off.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: theme.panel });
      } finally {
        off.dispose();
        host.remove();
      }
    }
  }));

  useEffect(() => {
    if (!option || !el.current) return;
    const chart = echarts.init(el.current, undefined, { renderer });
    inst.current = chart;
    chart.on('click', (p) => {
      const ri = (p.data as { ri?: number } | undefined)?.ri;
      if (typeof ri === 'number') clickRef.current?.(ri);
    });
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      chart.dispose();
      inst.current = null;
    };
    // Re-create only when switching between canvas, SVG and HTML charts.
  }, [option === null, renderer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (option && inst.current) inst.current.setOption(option, true);
  }, [option]);

  if (option) return <div ref={el} className="chart-canvas" data-testid="echart" />;
  if (type === 'kpi') return <Kpis spec={spec} result={result} />;
  if (type === 'pivot') return <Pivot spec={spec} result={result} />;
  return <ResultTable spec={spec} result={result} selectedKey={selectedKey} onRowClick={onMarkClick} />;
});

function Kpis({ spec, result }: { spec: VizSpec; result: QueryResult }): React.JSX.Element {
  const L = bind(spec, result);
  const row = result.rows[0];
  return (
    <div className="html-chart kpis">
      {L.measures.map((m) => (
        <div className="kpi" key={m.item.id}>
          <div className="value">{row ? fmt(m, row[m.index]) : '–'}</div>
          <div className="label">{m.col.label}</div>
        </div>
      ))}
    </div>
  );
}

function isNum(b: Bound): boolean {
  return b.col.type === 'number' || b.col.type === 'integer';
}

function ResultTable({
  spec,
  result,
  selectedKey,
  onRowClick
}: {
  spec: VizSpec;
  result: QueryResult;
  selectedKey?: string;
  onRowClick?: (ri: number) => void;
}): React.JSX.Element {
  const L = bind(spec, result);
  const cols = [...L.dims, ...L.measures].filter((b, i, arr) => arr.findIndex((x) => x.index === b.index) === i);
  return (
    <div className="html-chart">
      <table className="result">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.item.id} className={isNum(c) ? 'num' : ''}>
                {c.col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, ri) => {
            const k = rowKey(L, r);
            const cls = selectedKey === undefined ? '' : k === selectedKey ? 'selected' : 'dimmed';
            return (
              <tr key={ri} className={cls} onClick={() => onRowClick?.(ri)}>
                {cols.map((c) => (
                  <td key={c.item.id} className={isNum(c) ? 'num' : ''}>
                    {fmt(c, r[c.index])}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pivot({ spec, result }: { spec: VizSpec; result: QueryResult }): React.JSX.Element {
  const L = bind(spec, result);
  let rowDims = L.rowDims;
  let colDims = L.colDims;
  if (rowDims.length === 0 && colDims.length === 0) rowDims = L.dims;
  if (L.color?.col.role === 'dimension' && !colDims.includes(L.color)) colDims = [...colDims, L.color];
  const measures = L.measures;
  const keyOf = (dims: Bound[], r: Scalar[]): string => JSON.stringify(dims.map((d) => r[d.index]));
  const rowMap = new Map<string, string[]>();
  const colMap = new Map<string, string[]>();
  const cells = new Map<string, Scalar[]>();
  for (const r of result.rows) {
    const rk = keyOf(rowDims, r);
    const ck = keyOf(colDims, r);
    if (!rowMap.has(rk))
      rowMap.set(
        rk,
        rowDims.map((d) => fmt(d, r[d.index]))
      );
    if (!colMap.has(ck))
      colMap.set(
        ck,
        colDims.map((d) => fmt(d, r[d.index]))
      );
    cells.set(`${rk}|${ck}`, r);
  }
  const rowKeys = [...rowMap].map(([key, labels]) => ({ key, labels }));
  const colKeys = [...colMap].map(([key, labels]) => ({ key, labels }));
  return (
    <div className="html-chart">
      <table className="result pivot">
        <thead>
          <tr>
            {rowDims.map((d) => (
              <th key={d.item.id} className="rowhead">
                {d.col.label}
              </th>
            ))}
            {colKeys.flatMap((ck) =>
              measures.map((m) => (
                <th key={`${ck.key}-${m.item.id}`} className="num">
                  {[...ck.labels, measures.length > 1 || ck.labels.length === 0 ? m.col.label : ''].filter(Boolean).join(' · ')}
                </th>
              ))
            )}
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((rk) => (
            <tr key={rk.key}>
              {rk.labels.map((l, i) => (
                <th key={i} className="rowhead">
                  {l}
                </th>
              ))}
              {colKeys.flatMap((ck) =>
                measures.map((m) => {
                  const r = cells.get(`${rk.key}|${ck.key}`);
                  return (
                    <td key={`${ck.key}-${m.item.id}`} className="num">
                      {r ? fmt(m, r[m.index]) : ''}
                    </td>
                  );
                })
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
