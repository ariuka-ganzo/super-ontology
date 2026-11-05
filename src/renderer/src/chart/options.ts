import type { EChartsOption, SeriesOption } from 'echarts';
import { formatValue } from '@shared/format';
import type { ChartType, OutputColumn, QueryResult, Scalar, ShelfItem, VizSpec } from '@shared/types';

export interface ChartTheme {
  text: string;
  muted: string;
  border: string;
  panel: string;
  palette: string[];
  /** Two-colour ramp for measures on the color shelf. */
  ramp: [string, string];
}

export const LIGHT: ChartTheme = {
  text: '#1d2330',
  muted: '#5f6878',
  border: '#dfe2e8',
  panel: '#ffffff',
  palette: ['#2f6fdf', '#e8833a', '#2b9a74', '#d64f6b', '#8a63d2', '#c9a227', '#3fa8c9', '#9b6a4f', '#5f6b7a', '#c45fb4'],
  ramp: ['#d6e4fb', '#1d4fae']
};

export const DARK: ChartTheme = {
  text: '#e4e7ec',
  muted: '#a3abb9',
  border: '#2e3440',
  panel: '#1c2027',
  palette: ['#5b93f5', '#f39a55', '#4fc39f', '#ee7088', '#a98bf0', '#e0bb44', '#5cc0df', '#c08b6c', '#8f9aab', '#e07fd1'],
  ramp: ['#25344f', '#8db5ff']
};

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Data values and field names are untrusted; ECharts tooltips render HTML, so escape everything. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

export interface Bound {
  col: OutputColumn;
  item: ShelfItem;
  index: number;
}

export interface Layout {
  dims: Bound[];
  measures: Bound[];
  colDims: Bound[];
  rowDims: Bound[];
  colMeasures: Bound[];
  rowMeasures: Bound[];
  color?: Bound;
  size?: Bound;
  label?: Bound;
  tooltip: Bound[];
}

export function bind(spec: VizSpec, result: QueryResult): Layout {
  const b = (item: ShelfItem | undefined): Bound | undefined => {
    if (!item) return undefined;
    const index = result.columns.findIndex((c) => c.key === item.id);
    return index < 0 ? undefined : { col: result.columns[index], item, index };
  };
  const all = (items: ShelfItem[]): Bound[] => items.map(b).filter((x): x is Bound => !!x);
  const cols = all(spec.columns);
  const rows = all(spec.rows);
  const color = b(spec.color);
  const size = b(spec.size);
  const label = b(spec.label);
  const tooltip = all(spec.tooltip);
  const every = [...cols, ...rows, ...(color ? [color] : []), ...(size ? [size] : []), ...(label ? [label] : []), ...tooltip];
  return {
    dims: every.filter((x) => x.col.role === 'dimension'),
    measures: every.filter((x) => x.col.role === 'measure'),
    colDims: cols.filter((x) => x.col.role === 'dimension'),
    rowDims: rows.filter((x) => x.col.role === 'dimension'),
    colMeasures: cols.filter((x) => x.col.role === 'measure'),
    rowMeasures: rows.filter((x) => x.col.role === 'measure'),
    color,
    size,
    label,
    tooltip
  };
}

export function fmt(b: Bound, v: Scalar): string {
  return formatValue(v, b.col.type, b.item.format, b.col.dateLevel);
}

/** Key that identifies a mark by its dimension values, for cross-filter highlighting. */
export function rowKey(layout: Layout, row: Scalar[]): string {
  return JSON.stringify(layout.dims.map((d) => row[d.index]));
}

interface Datum {
  value: unknown;
  ri: number;
  lbl?: string;
  itemStyle?: { color?: string; opacity?: number };
  name?: string;
}

function lerpColor(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return (
    '#' +
    pa
      .map((x, i) =>
        Math.round(x + (pb[i] - x) * t)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  );
}

function numeric(v: Scalar): number | null {
  return typeof v === 'number' ? v : v === null ? null : Number(v);
}

function extent(values: (number | null)[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return lo === Infinity ? [0, 0] : [lo, hi];
}

export interface BuildArgs {
  type: ChartType;
  spec: VizSpec;
  result: QueryResult;
  theme: ChartTheme;
  selectedKey?: string;
  compact?: boolean;
}

/** Builds the ECharts option for chart types drawn on a canvas. Returns null for HTML ones. */
export function buildOption({ type, spec, result, theme, selectedKey, compact }: BuildArgs): EChartsOption | null {
  if (type === 'table' || type === 'pivot' || type === 'kpi') return null;
  const L = bind(spec, result);
  const rows = result.rows;
  const opacity = (ri: number): number | undefined => (selectedKey === undefined ? undefined : rowKey(L, rows[ri]) === selectedKey ? 1 : 0.3);

  const tooltipHtml = (ri: number): string => {
    const row = rows[ri];
    const seen = new Set<number>();
    const lines: string[] = [];
    for (const b of [...L.dims, ...L.measures]) {
      if (seen.has(b.index)) continue;
      seen.add(b.index);
      lines.push(`<span style="color:${theme.muted}">${escapeHtml(b.col.label)}</span>&nbsp;&nbsp;<b>${escapeHtml(fmt(b, row[b.index]))}</b>`);
    }
    return lines.join('<br/>');
  };

  const base: EChartsOption = {
    animation: rows.length < 2000,
    color: theme.palette,
    textStyle: { color: theme.text, fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' },
    tooltip: {
      trigger: 'item',
      confine: true,
      backgroundColor: theme.panel,
      borderColor: theme.border,
      textStyle: { color: theme.text, fontSize: 12 },
      formatter: (p: unknown) => {
        const d = (p as { data?: Datum }).data;
        return d && typeof d.ri === 'number' ? tooltipHtml(d.ri) : '';
      }
    },
    grid: { left: 12, right: 24, top: compact ? 28 : 36, bottom: 12, containLabel: true }
  };

  const axisCommon = {
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { lineStyle: { color: theme.border } },
    axisLabel: { color: theme.muted, hideOverlap: true },
    splitLine: { lineStyle: { color: theme.border, type: 'dashed' as const } },
    nameTextStyle: { color: theme.muted }
  };

  if (type === 'scatter') {
    const xm = L.colMeasures[0] ?? L.measures[0];
    const ym = L.rowMeasures[0] ?? L.measures.find((m) => m !== xm);
    if (!xm || !ym) return null;
    const seriesDim = L.color?.col.role === 'dimension' ? L.color : undefined;
    const sizeM = L.size?.col.role === 'measure' ? L.size : undefined;
    const [slo, shi] = sizeM ? extent(rows.map((r) => numeric(r[sizeM.index]))) : [0, 0];
    const groups = new Map<string, Datum[]>();
    rows.forEach((r, ri) => {
      const g = seriesDim ? fmt(seriesDim, r[seriesDim.index]) : ym.col.label;
      const s = sizeM ? numeric(r[sizeM.index]) : null;
      const d: Datum = {
        value: sizeM ? [r[xm.index], r[ym.index], s] : [r[xm.index], r[ym.index]],
        ri,
        itemStyle: { opacity: opacity(ri) ?? 0.8 }
      };
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)?.push(d);
    });
    return {
      ...base,
      legend: seriesDim ? { type: 'scroll', top: 0, textStyle: { color: theme.muted } } : undefined,
      xAxis: {
        type: 'value',
        name: xm.col.label,
        nameLocation: 'middle',
        nameGap: 28,
        scale: true,
        ...axisCommon,
        axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => fmt(xm, v) }
      },
      yAxis: { type: 'value', name: ym.col.label, scale: true, ...axisCommon, axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => fmt(ym, v) } },
      series: [...groups.entries()].map(([name, data]) => ({
        type: 'scatter',
        name,
        data,
        symbolSize: sizeM
          ? (val: unknown) => {
              const s = (val as number[])[2];
              return shi === slo || s === null ? 12 : 6 + 34 * Math.sqrt((s - slo) / (shi - slo));
            }
          : 10
      })) as SeriesOption[]
    };
  }

  if (type === 'pie' || type === 'donut') {
    const cat = (L.color?.col.role === 'dimension' ? L.color : undefined) ?? L.dims[0];
    const m = L.measures[0];
    if (!cat || !m) return null;
    return {
      ...base,
      legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle', textStyle: { color: theme.muted } },
      series: [
        {
          type: 'pie',
          radius: type === 'donut' ? ['45%', '72%'] : '72%',
          center: ['42%', '52%'],
          itemStyle: { borderColor: theme.panel, borderWidth: 2 },
          label: { color: theme.text, formatter: (p: { percent?: number }) => `${p.percent?.toFixed(1)}%` },
          data: rows.map((r, ri) => ({ name: fmt(cat, r[cat.index]), value: r[m.index], ri, itemStyle: { opacity: opacity(ri) } }))
        }
      ] as SeriesOption[]
    };
  }

  if (type === 'heatmap') {
    const xd = L.colDims[0] ?? L.dims[0];
    const yd = L.rowDims[0] ?? L.dims.find((d) => d !== xd);
    const m = (L.color?.col.role === 'measure' ? L.color : undefined) ?? L.measures[0];
    if (!xd || !yd || !m) return null;
    const xs = [...new Set(rows.map((r) => fmt(xd, r[xd.index])))];
    const ys = [...new Set(rows.map((r) => fmt(yd, r[yd.index])))];
    const [lo, hi] = extent(rows.map((r) => numeric(r[m.index])));
    return {
      ...base,
      grid: { ...base.grid, bottom: 52 },
      xAxis: { type: 'category', data: xs, ...axisCommon, splitArea: { show: false } },
      yAxis: { type: 'category', data: ys, ...axisCommon, splitArea: { show: false } },
      visualMap: {
        min: lo,
        max: hi === lo ? lo + 1 : hi,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        inRange: { color: theme.ramp },
        textStyle: { color: theme.muted },
        formatter: (v: unknown) => fmt(m, v as number)
      },
      series: [
        {
          type: 'heatmap',
          label: {
            show: !!L.label || xs.length * ys.length <= 120,
            color: theme.text,
            formatter: (p: { data?: Datum }) => (p.data ? fmt(m, (p.data.value as Scalar[])[2]) : '')
          },
          data: rows.map((r, ri) => ({
            value: [xs.indexOf(fmt(xd, r[xd.index])), ys.indexOf(fmt(yd, r[yd.index])), r[m.index]],
            ri,
            itemStyle: { opacity: opacity(ri) }
          })),
          itemStyle: { borderColor: theme.panel, borderWidth: 1 }
        }
      ] as SeriesOption[]
    };
  }

  // Bar, stacked bar, line and area.
  const horizontal = L.colMeasures.length > 0 && L.rowMeasures.length === 0 && L.rowDims.length > 0;
  let catDims = horizontal ? L.rowDims : L.colDims;
  if (catDims.length === 0) catDims = horizontal ? L.colDims : L.rowDims;
  let measures = horizontal ? L.colMeasures : L.rowMeasures;
  if (measures.length === 0) measures = [...L.colMeasures, ...L.rowMeasures];
  if (measures.length === 0) measures = L.measures.filter((m) => m !== L.color && m !== L.size && m !== L.label && !L.tooltip.includes(m));
  if (measures.length === 0 && L.measures[0]) measures = [L.measures[0]];
  if (measures.length === 0) return null;
  let seriesDim = L.color?.col.role === 'dimension' ? L.color : undefined;
  if (!seriesDim && catDims.length > 1 && (type === 'stackedBar' || type === 'area')) {
    seriesDim = catDims[catDims.length - 1];
    catDims = catDims.slice(0, -1);
  }
  const catLabel = (r: Scalar[]): string => (catDims.length ? catDims.map((d) => fmt(d, r[d.index])).join(' · ') : 'All');
  const categories = [...new Set(rows.map(catLabel))];
  const catIndex = new Map(categories.map((c, i) => [c, i]));
  const colorMeasure = L.color?.col.role === 'measure' ? L.color : undefined;
  const [clo, chi] = colorMeasure ? extent(rows.map((r) => numeric(r[colorMeasure.index]))) : [0, 0];
  const label = L.label;
  const isLine = type === 'line' || type === 'area';
  const stacked = type === 'stackedBar' || (type === 'area' && !!seriesDim);

  const series: SeriesOption[] = [];
  const makeSeries = (name: string, m: Bound, filter: (r: Scalar[]) => boolean, colorIndex: number): void => {
    const data: (Datum | null)[] = categories.map(() => null);
    rows.forEach((r, ri) => {
      if (!filter(r)) return;
      const ci = catIndex.get(catLabel(r)) as number;
      const v = r[m.index];
      const d: Datum = { value: v, ri, itemStyle: {} };
      if (label) d.lbl = fmt(label, r[label.index]);
      if (colorMeasure) {
        const c = numeric(r[colorMeasure.index]);
        d.itemStyle = { color: c === null || chi === clo ? theme.ramp[1] : lerpColor(theme.ramp[0], theme.ramp[1], (c - clo) / (chi - clo)) };
      }
      const op = opacity(ri);
      if (op !== undefined) d.itemStyle = { ...d.itemStyle, opacity: op };
      data[ci] = d;
    });
    series.push({
      type: isLine ? 'line' : 'bar',
      name,
      data,
      stack: stacked ? 'total' : undefined,
      areaStyle: type === 'area' ? { opacity: 0.35 } : undefined,
      smooth: false,
      showSymbol: isLine && categories.length <= 60,
      symbolSize: 6,
      connectNulls: false,
      barMaxWidth: 48,
      color: colorMeasure ? undefined : theme.palette[colorIndex % theme.palette.length],
      emphasis: { focus: 'none' },
      label: label
        ? {
            show: true,
            position: horizontal ? 'right' : 'top',
            color: theme.text,
            fontSize: 11,
            formatter: (p: { data?: Datum }) => p.data?.lbl ?? ''
          }
        : undefined
    } as SeriesOption);
  };

  if (seriesDim) {
    const sd = seriesDim;
    const values = [...new Set(rows.map((r) => fmt(sd, r[sd.index])))];
    let ci = 0;
    for (const m of measures) for (const v of values) makeSeries(measures.length > 1 ? `${v} · ${m.col.label}` : v, m, (r) => fmt(sd, r[sd.index]) === v, ci++);
  } else measures.forEach((m, i) => makeSeries(m.col.label, m, () => true, i));

  const m0 = measures[0];
  const catAxis = {
    type: 'category' as const,
    data: categories,
    ...axisCommon,
    splitLine: { show: false },
    axisLabel: { ...axisCommon.axisLabel, rotate: !horizontal && categories.length > 12 ? 40 : 0 },
    boundaryGap: !isLine
  };
  const valAxis = {
    type: 'value' as const,
    ...axisCommon,
    name: measures.length === 1 && !compact ? m0.col.label : undefined,
    axisLabel: { ...axisCommon.axisLabel, formatter: (v: number) => fmt(m0, v) }
  };
  const many = categories.length > 60;
  return {
    ...base,
    legend: series.length > 1 ? { type: 'scroll', top: 0, textStyle: { color: theme.muted } } : undefined,
    grid: { ...base.grid, top: series.length > 1 ? 36 : 24, bottom: many ? 44 : 12 },
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? { ...catAxis, inverse: true } : valAxis,
    dataZoom: many
      ? [{ type: 'slider', [horizontal ? 'yAxisIndex' : 'xAxisIndex']: 0, height: 18, bottom: 8, end: Math.min(100, (60 / categories.length) * 100) }]
      : undefined,
    series
  };
}

/** Filters that select one mark: the values of every dimension in its row. */
export function markFilters(spec: VizSpec, result: QueryResult, ri: number): { item: ShelfItem; value: Scalar; label: string }[] {
  const L = bind(spec, result);
  const row = result.rows[ri];
  const seen = new Set<string>();
  const out: { item: ShelfItem; value: Scalar; label: string }[] = [];
  for (const d of L.dims) {
    const k = JSON.stringify([d.item.field, d.item.dateLevel ?? null]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ item: d.item, value: row[d.index], label: fmt(d, row[d.index]) });
  }
  return out;
}
