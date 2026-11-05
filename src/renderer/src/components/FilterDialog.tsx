import { useMemo, useState } from 'react';
import { itemLabel } from '@shared/compiler/compile';
import { formatValue } from '@shared/format';
import type { AggFn, CompareOp, DateLevel, FieldRef, FilterDef, Scalar, VizSpec } from '@shared/types';
import { defaultAggFor, fieldInfo, isAggregateCalc, isTemporal, listFields } from '../fields';
import { newId } from '../ids';
import { useVizQuery } from '../query';
import { useStore } from '../store';
import { Modal } from './Modal';

type Mode = 'values' | 'range' | 'measure' | 'topN';

export function FilterDialog({
  field,
  filter,
  onSave,
  onClose
}: {
  field: FieldRef;
  filter?: FilterDef;
  onSave: (f: FilterDef) => void;
  onClose: () => void;
}): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const info = fieldInfo(model, field);
  const temporal = isTemporal(info);
  const numeric = info?.vtype === 'number';
  const aggregate = isAggregateCalc(info);
  const modes: Mode[] = aggregate ? ['measure'] : temporal ? ['range', 'values'] : numeric ? ['measure', 'range', 'values'] : ['values', 'topN'];
  const [mode, setMode] = useState<Mode>(filter?.kind ?? modes[0]);
  const [context, setContext] = useState(filter?.context ?? false);

  const [values, setValues] = useState<Scalar[]>(filter?.kind === 'values' ? filter.values : []);
  const [exclude, setExclude] = useState(filter?.kind === 'values' ? !!filter.exclude : false);
  const [dateLevel, setDateLevel] = useState<DateLevel | undefined>(
    filter && (filter.kind === 'values' || filter.kind === 'range') ? filter.dateLevel : temporal ? 'year' : undefined
  );
  const [min, setMin] = useState<string>(filter?.kind === 'range' && filter.min !== null && filter.min !== undefined ? String(filter.min) : '');
  const [max, setMax] = useState<string>(filter?.kind === 'range' && filter.max !== null && filter.max !== undefined ? String(filter.max) : '');
  const [agg, setAgg] = useState<AggFn | undefined>(filter?.kind === 'measure' ? filter.agg : defaultAggFor(info));
  const [op, setOp] = useState<CompareOp>(filter?.kind === 'measure' ? filter.op : '>=');
  const [value, setValue] = useState<string>(filter?.kind === 'measure' ? String(filter.value) : '0');
  const [n, setN] = useState(filter?.kind === 'topN' ? filter.n : 10);
  const [direction, setDirection] = useState<'top' | 'bottom'>(filter?.kind === 'topN' ? filter.direction : 'top');
  const numberFields = listFields(model).filter((f) => f.role === 'measure' && !f.error);
  const [byKey, setByKey] = useState(filter?.kind === 'topN' ? JSON.stringify(filter.by.field) : numberFields[0] ? JSON.stringify(numberFields[0].ref) : '');
  const [byAgg, setByAgg] = useState<AggFn>(filter?.kind === 'topN' ? (filter.by.agg ?? 'SUM') : 'SUM');
  const [search, setSearch] = useState('');

  // Distinct values for the list, at the chosen date level.
  const spec: VizSpec | null = useMemo(
    () =>
      mode === 'values'
        ? {
            chartType: 'table',
            columns: [{ id: 'v', field, role: 'dimension', dateLevel: temporal ? dateLevel : undefined }],
            rows: [],
            tooltip: [],
            filters: []
          }
        : null,
    [mode, field, temporal, dateLevel]
  );
  const q = useVizQuery(model, spec, undefined, 5000);
  const options = q.result?.rows.map((r) => r[0]) ?? [];
  const shown = options.filter(
    (v) =>
      !search ||
      formatValue(v, info?.dataType ?? 'string', undefined, dateLevel)
        .toLowerCase()
        .includes(search.toLowerCase())
  );

  const build = (): FilterDef | null => {
    const id = filter?.id ?? newId('f');
    const ctx = context || undefined;
    if (mode === 'values')
      return { id, kind: 'values', field, values, exclude: exclude || undefined, dateLevel: temporal ? dateLevel : undefined, context: ctx };
    if (mode === 'range') {
      const parse = (s: string): Scalar | undefined => (s === '' ? undefined : temporal ? s : Number(s));
      return { id, kind: 'range', field, min: parse(min), max: parse(max), context: ctx };
    }
    if (mode === 'measure') {
      const v = Number(value);
      if (!Number.isFinite(v)) return null;
      return { id, kind: 'measure', field, agg: aggregate ? undefined : agg, op, value: v };
    }
    if (!byKey) return null;
    return { id, kind: 'topN', field, n, direction, by: { field: JSON.parse(byKey) as FieldRef, agg: byAgg }, context: ctx };
  };
  const built = build();
  const label = itemLabel({ id: 'x', field, role: 'dimension' }, model);
  const modeLabel: Record<Mode, string> = {
    values: 'Pick values',
    range: temporal ? 'Date range' : 'Range of values',
    measure: 'Aggregate condition',
    topN: 'Top N'
  };

  return (
    <Modal
      title={`Filter ${label}`}
      onClose={onClose}
      footer={
        <>
          {mode !== 'measure' && (
            <label className="row grow" title="Context filters run before FIXED expressions are calculated">
              <input type="checkbox" checked={context} onChange={(e) => setContext(e.target.checked)} />
              Context filter (apply before FIXED expressions)
            </label>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!built} onClick={() => built && (onSave(built), onClose())}>
            Apply filter
          </button>
        </>
      }
    >
      <div className="col">
        {modes.length > 1 && (
          <div className="row">
            {modes.map((m) => (
              <button key={m} className={m === mode ? 'primary' : ''} onClick={() => setMode(m)}>
                {modeLabel[m]}
              </button>
            ))}
          </div>
        )}
        {mode === 'values' && (
          <>
            <div className="row">
              {temporal && (
                <select
                  aria-label="Date level"
                  value={dateLevel ?? ''}
                  onChange={(e) => (setDateLevel((e.target.value || undefined) as DateLevel | undefined), setValues([]))}
                >
                  <option value="year">Year</option>
                  <option value="quarter">Quarter</option>
                  <option value="month">Month</option>
                  <option value="day">Day</option>
                </select>
              )}
              <input placeholder="Search values" value={search} onChange={(e) => setSearch(e.target.value)} className="grow" />
              <button className="small" onClick={() => setValues([...new Set([...values, ...shown])])}>
                All
              </button>
              <button className="small" onClick={() => setValues([])}>
                None
              </button>
              <label className="row">
                <input type="checkbox" checked={exclude} onChange={(e) => setExclude(e.target.checked)} />
                Exclude selected
              </label>
            </div>
            {q.error && <div className="banner error">{q.error}</div>}
            {q.result?.truncated && <div className="banner warning">Showing the first {q.result.limit.toLocaleString('en-US')} values only.</div>}
            <div style={{ maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 6, padding: 6 }}>
              {shown.map((v) => {
                const key = JSON.stringify(v);
                const on = values.some((x) => JSON.stringify(x) === key);
                return (
                  <label key={key} className="row" style={{ padding: '2px 0' }}>
                    <input type="checkbox" checked={on} onChange={() => setValues(on ? values.filter((x) => JSON.stringify(x) !== key) : [...values, v])} />
                    {formatValue(v, info?.dataType ?? 'string', undefined, dateLevel)}
                  </label>
                );
              })}
              {q.loading && <span className="muted">Loading values…</span>}
            </div>
            <span className="muted">
              {values.length} selected.{' '}
              {exclude
                ? 'Rows with these values are removed.'
                : values.length === 0
                  ? 'Nothing selected means no rows pass.'
                  : 'Only rows with these values are kept.'}
            </span>
          </>
        )}
        {mode === 'range' && (
          <div className="row">
            <label className="col grow" style={{ gap: 4 }}>
              From (inclusive, empty for no limit)
              <input aria-label="Minimum" type={temporal ? 'date' : 'number'} value={min} onChange={(e) => setMin(e.target.value)} />
            </label>
            <label className="col grow" style={{ gap: 4 }}>
              To (inclusive, empty for no limit)
              <input aria-label="Maximum" type={temporal ? 'date' : 'number'} value={max} onChange={(e) => setMax(e.target.value)} />
            </label>
          </div>
        )}
        {mode === 'measure' && (
          <div className="row">
            {!aggregate && (
              <select aria-label="Aggregation" value={agg} onChange={(e) => setAgg(e.target.value as AggFn)}>
                {['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'MEDIAN'].map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </select>
            )}
            <span>of {label}</span>
            <select aria-label="Comparison" value={op} onChange={(e) => setOp(e.target.value as CompareOp)}>
              {['>', '>=', '<', '<=', '=', '!='].map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            <input aria-label="Value" type="number" value={value} onChange={(e) => setValue(e.target.value)} />
            <span className="muted">Checked after grouping, for each mark.</span>
          </div>
        )}
        {mode === 'topN' && (
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <select aria-label="Direction" value={direction} onChange={(e) => setDirection(e.target.value as 'top' | 'bottom')}>
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
            </select>
            <input
              aria-label="Count"
              type="number"
              min={1}
              value={n}
              onChange={(e) => setN(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              style={{ width: 80 }}
            />
            <span>by</span>
            <select aria-label="Aggregation" value={byAgg} onChange={(e) => setByAgg(e.target.value as AggFn)}>
              {['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD'].map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
            <select aria-label="Ranked by" value={byKey} onChange={(e) => setByKey(e.target.value)}>
              {numberFields.map((f) => (
                <option key={f.key} value={JSON.stringify(f.ref)}>
                  {f.tableName ? `${f.tableName}.` : ''}
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function filterSummary(f: FilterDef, label: string): string {
  switch (f.kind) {
    case 'values':
      return `${label}: ${f.exclude ? 'not ' : ''}${f.values.length === 1 ? String(f.values[0]) : `${f.values.length} values`}`;
    case 'range':
      return `${label}: ${f.min ?? '…'} to ${f.max ?? '…'}`;
    case 'measure':
      return `${f.agg ?? ''}${f.agg ? '(' : ''}${label}${f.agg ? ')' : ''} ${f.op} ${f.value}`;
    case 'topN':
      return `${f.direction === 'top' ? 'Top' : 'Bottom'} ${f.n} ${label}`;
  }
}
