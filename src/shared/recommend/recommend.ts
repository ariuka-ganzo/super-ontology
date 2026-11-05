import { shelfItems } from '../compiler/compile';
import { fieldNode } from '../formula/check';
import type { ChartType, Model, VizSpec } from '../types';

export interface ViewShape {
  /** Dimensions in shelf order; `temporal` is true for date fields. */
  dims: { temporal: boolean }[];
  measures: number;
}

export interface Recommendation {
  type: ChartType;
  reason: string;
}

export const CHART_LABELS: Record<ChartType, string> = {
  bar: 'Bar',
  stackedBar: 'Stacked bar',
  line: 'Line',
  area: 'Area',
  scatter: 'Scatter',
  pie: 'Pie',
  donut: 'Donut',
  heatmap: 'Heatmap',
  table: 'Table',
  pivot: 'Pivot table',
  kpi: 'KPI card'
};

/** Describes which kinds of fields a view uses, for chart recommendation. */
export function viewShape(spec: VizSpec, model: Model): ViewShape {
  const dims: { temporal: boolean }[] = [];
  let measures = 0;
  for (const item of shelfItems(spec)) {
    if (item.role === 'measure') {
      measures++;
      continue;
    }
    let temporal = false;
    try {
      const n = fieldNode(item.field, model);
      temporal = n.vtype === 'date' || n.vtype === 'datetime';
    } catch {
      temporal = false;
    }
    dims.push({ temporal });
  }
  return { dims, measures };
}

/** Requirements for each chart type. Table and pivot accept anything. */
export function chartFits(type: ChartType, s: ViewShape): boolean {
  const d = s.dims.length;
  const m = s.measures;
  switch (type) {
    case 'kpi':
      return d === 0 && m >= 1 && m <= 4;
    case 'bar':
    case 'line':
    case 'area':
      return d >= 1 && d <= 2 && m >= 1;
    case 'stackedBar':
      return d === 2 && m === 1;
    case 'pie':
    case 'donut':
      return d === 1 && m === 1;
    case 'scatter':
      return m >= 2 && d <= 2;
    case 'heatmap':
      return d === 2 && m === 1;
    case 'table':
    case 'pivot':
      return d + m >= 1;
  }
}

/** Ranks chart types for the fields in a view, best first, with a short reason. */
export function recommendCharts(s: ViewShape): Recommendation[] {
  const d = s.dims.length;
  const m = s.measures;
  const temporal = s.dims.filter((x) => x.temporal).length;
  const out: Recommendation[] = [];
  const add = (type: ChartType, reason: string): void => {
    if (chartFits(type, s) && !out.some((r) => r.type === type)) out.push({ type, reason });
  };
  if (d === 0 && m >= 1) add('kpi', 'A single number stands out best as a KPI card');
  if (m >= 2 && d <= 1) add('scatter', 'Two measures can be compared as a scatter plot');
  if (temporal >= 1 && d <= 2 && m >= 1) {
    add('line', 'A date on the axis shows a trend over time');
    add('area', 'An area chart shows a trend and its volume');
  }
  if (d === 2 && m === 1) {
    if (temporal === 0) add('heatmap', 'Two dimensions and one measure form a heatmap grid');
    add('stackedBar', 'Stacked bars show how the second dimension splits each bar');
    add('pivot', 'A pivot table shows exact values for both dimensions');
  }
  if (d === 1 && m >= 1) add('bar', 'Bars compare a measure across categories');
  if (d === 1 && m === 1 && temporal === 0) {
    add('donut', 'A donut shows parts of a whole for a few categories');
    add('pie', 'A pie shows parts of a whole for a few categories');
  }
  add('bar', 'Bars compare a measure across categories');
  add('heatmap', 'Two dimensions and one measure form a heatmap grid');
  add('pivot', 'A pivot table shows exact values');
  add('table', 'A table shows every value');
  return out;
}

/** Chart type to draw: the user's choice when it fits, otherwise the best recommendation. */
export function resolveChartType(spec: VizSpec, model: Model): ChartType {
  const shape = viewShape(spec, model);
  if (spec.chartType !== 'auto') return spec.chartType;
  return recommendCharts(shape)[0]?.type ?? 'table';
}
