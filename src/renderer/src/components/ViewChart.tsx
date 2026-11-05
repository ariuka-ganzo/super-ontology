import { forwardRef, useEffect, useState } from 'react';
import { chartFits, CHART_LABELS, recommendCharts, resolveChartType, viewShape } from '@shared/recommend/recommend';
import type { FilterDef, QueryResult, VizSpec } from '@shared/types';
import { Chart, type ChartHandle } from '../chart/Chart';
import { useVizQuery } from '../query';
import { useStore } from '../store';

interface Props {
  spec: VizSpec;
  externalFilters?: FilterDef[];
  selectedKey?: string;
  onMarkClick?: (rowIndex: number, result: QueryResult) => void;
  compact?: boolean;
  onResult?: (r: QueryResult | null) => void;
}

/** Runs a view's query and draws it, with notices for truncation, warnings, errors and slow queries. */
export const ViewChart = forwardRef<ChartHandle, Props>(function ViewChart({ spec, externalFilters, selectedKey, onMarkClick, compact, onResult }, ref) {
  const model = useStore((s) => s.project.model);
  const hasFields = spec.columns.length + spec.rows.length + spec.tooltip.length + (spec.color ? 1 : 0) + (spec.size ? 1 : 0) + (spec.label ? 1 : 0) > 0;
  const q = useVizQuery(model, hasFields ? spec : null, externalFilters);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (!q.loading) {
      setSlow(false);
      return;
    }
    const t = setTimeout(() => setSlow(true), 600);
    return () => clearTimeout(t);
  }, [q.loading]);

  useEffect(() => {
    onResult?.(q.result);
  }, [q.result, onResult]);

  if (!hasFields)
    return (
      <div className="empty">
        <span>Drag fields to Columns and Rows, or double-click a field.</span>
      </div>
    );

  const type = resolveChartType(spec, model);
  const shape = viewShape(spec, model);
  const fits = chartFits(type, shape);
  const result = q.result;

  return (
    <div className="col" style={{ height: '100%', gap: 4 }}>
      {q.error && (
        <div className="banner error" data-testid="view-error">
          {q.error}
        </div>
      )}
      {result?.truncated && (
        <div className="banner warning" data-testid="truncated">
          Showing the first {result.limit.toLocaleString('en-US')} rows. The full result is larger; add a filter or use fewer dimensions to see everything.
        </div>
      )}
      {result?.warnings.map((w) => (
        <div className="banner warning" key={w} data-testid="view-warning">
          {w}
        </div>
      ))}
      {!fits && (
        <div className="banner info">
          A {CHART_LABELS[type].toLowerCase()} does not suit these fields.{' '}
          {recommendCharts(shape)[0] ? `Try ${CHART_LABELS[recommendCharts(shape)[0].type].toLowerCase()}.` : ''}
        </div>
      )}
      <div className="chart-box" data-testid="chart-box" data-chart-type={type}>
        {slow && (
          <div className="loading-veil">
            <span>Running query…</span>
            <button className="small" onClick={q.cancel}>
              Cancel
            </button>
          </div>
        )}
        {result && fits && result.rows.length === 0 && <div className="empty">No data matches the filters.</div>}
        {result && fits && result.rows.length > 0 && (
          <Chart
            ref={ref}
            type={type}
            spec={spec}
            result={result}
            selectedKey={selectedKey}
            onMarkClick={onMarkClick ? (ri) => onMarkClick(ri, result) : undefined}
            compact={compact}
          />
        )}
      </div>
    </div>
  );
});
