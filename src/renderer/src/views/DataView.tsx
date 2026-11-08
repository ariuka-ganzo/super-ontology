import { useEffect, useState } from 'react';
import type { ColumnProfile, PreviewResult } from '@shared/api';
import { formatValue } from '@shared/format';
import { isServerFormat, type DataType, type TableDef } from '@shared/types';
import { chooseAndImport, importDbItems, locateTable, openSample, reloadTable, removeTable } from '../actions';
import { DatabaseDialog } from '../components/DatabaseDialog';
import { StepsPanel } from '../components/StepsPanel';
import { clearQueryCache } from '../query';
import { useStore } from '../store';

const TYPES: { value: DataType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'integer', label: 'Whole number' },
  { value: 'number', label: 'Decimal' },
  { value: 'boolean', label: 'True/False' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' }
];

const PAGE = 200;

export function DataView(): React.JSX.Element {
  const tables = useStore((s) => s.project.model.tables);
  const tableId = useStore((s) => s.tableId);
  const select = useStore((s) => s.selectTable);
  const table = tables.find((t) => t.id === tableId) ?? tables[0];
  const [connecting, setConnecting] = useState(false);

  const dialog = connecting && (
    <DatabaseDialog
      onClose={() => setConnecting(false)}
      onImport={(items, password) => {
        setConnecting(false);
        void importDbItems(items, password);
      }}
    />
  );

  if (!table)
    return (
      <div className="view">
        <div className="welcome">
          <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="faint">
            <ellipse cx="12" cy="5" rx="8" ry="3" />
            <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
          </svg>
          <h2>Bring in some data</h2>
          <p className="muted">
            Import CSV, TSV, Parquet, JSON, Excel or SQLite files, or copy tables in from a PostgreSQL or MySQL database. You can also drag files onto this
            window.
          </p>
          <div className="actions">
            <button className="primary" onClick={() => void chooseAndImport()}>
              Import data…
            </button>
            <button onClick={() => setConnecting(true)}>Connect to a database…</button>
            <button onClick={() => void openSample()}>Open the sample project</button>
          </div>
        </div>
        {dialog}
      </div>
    );
  const server = isServerFormat(table.source.format);
  const what = table.source.query !== undefined ? ' · query' : table.source.table ? ` · ${table.source.table.name}` : '';

  return (
    <div className="view">
      <div className="view-header">
        <select value={table.id} onChange={(e) => select(e.target.value)} aria-label="Table">
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <TableName table={table} />
        <span className="muted">{table.rowCount.toLocaleString('en-US')} rows</span>
        <span className="faint grow" title={table.source.path} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {table.source.path}
          {table.source.sheet ? ` · sheet ${table.source.sheet}` : ''}
          {what}
        </span>
        <button onClick={() => void reloadTable(table.id)} title={server ? 'Copy the latest data from the database' : 'Read the file again'}>
          Reload
        </button>
        {!server && <button onClick={() => void locateTable(table.id)}>Locate file…</button>}
        <button
          className="danger"
          onClick={() => {
            if (window.confirm(`Remove ${table.name} from the project? Views that use it will show an error.`)) void removeTable(table.id);
          }}
        >
          Remove
        </button>
        <button onClick={() => setConnecting(true)}>Database…</button>
        <button className="primary" onClick={() => void chooseAndImport()}>
          Import data…
        </button>
      </div>
      <TableData key={table.id} table={table} />
      {dialog}
    </div>
  );
}

function TableName({ table }: { table: TableDef }): React.JSX.Element {
  const update = useStore((s) => s.update);
  const [name, setName] = useState(table.name);
  useEffect(() => setName(table.name), [table.name]);
  return (
    <input
      aria-label="Table name"
      value={name}
      style={{ width: 180 }}
      onChange={(e) => setName(e.target.value)}
      onBlur={() => {
        const n = name.trim();
        if (n && n !== table.name)
          update((p) => {
            const t = p.model.tables.find((x) => x.id === table.id);
            if (t) t.name = n;
          });
        else setName(table.name);
      }}
    />
  );
}

function TableData({ table }: { table: TableDef }): React.JSX.Element {
  const error = useStore((s) => s.tableErrors[table.id]);
  const update = useStore((s) => s.update);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [column, setColumn] = useState<string | null>(table.columns[0]?.name ?? null);
  // The cleaning step whose result the grid shows; null shows the result of every step.
  const [upto, setUpto] = useState<string | null>(null);
  const steps = table.steps ?? [];
  const uptoIndex = upto ? steps.findIndex((s) => s.id === upto) : -1;
  const atStep = uptoIndex >= 0 && uptoIndex < steps.length - 1;
  const dataVersion = useStore((s) => s.dataVersion);
  const typesKey = JSON.stringify(table.columns.map((c) => [c.name, c.override ?? null])) + table.rowCount + JSON.stringify(steps) + dataVersion;

  useEffect(() => {
    if (error) return;
    let alive = true;
    window.ontology
      .preview(table, limit, 0, atStep ? (upto ?? undefined) : undefined)
      .then((p) => alive && (setPreview(p), setFailed(null)))
      .catch((e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typesKey, limit, error, upto]);

  if (error)
    return (
      <div className="empty">
        <div className="banner error" style={{ maxWidth: 640 }}>
          {error}
        </div>
        <div className="row">
          {!isServerFormat(table.source.format) && (
            <button className="primary" onClick={() => void locateTable(table.id)}>
              Locate file…
            </button>
          )}
          <button onClick={() => void reloadTable(table.id)}>Try again</button>
        </div>
      </div>
    );

  const setOverride = (name: string, t: DataType): void => {
    update((p) => {
      const c = p.model.tables.find((x) => x.id === table.id)?.columns.find((x) => x.name === name);
      if (!c) return;
      if (t === c.type) delete c.override;
      else c.override = t;
    });
    clearQueryCache();
  };

  return (
    <div className="data-layout view-body">
      <StepsPanel table={table} selected={atStep ? upto : null} onSelect={setUpto} column={column} />
      <div className="grid-wrap">
        {failed && <div className="banner error">{failed}</div>}
        {atStep && (
          <div className="banner" data-testid="step-preview">
            Showing the data after step {uptoIndex + 1} of {steps.length}.{' '}
            <button className="small" onClick={() => setUpto(null)}>
              Show the result
            </button>
          </div>
        )}
        <table className="grid" data-testid="data-grid">
          <thead>
            <tr>
              {atStep &&
                preview?.columns.map((name) => (
                  <th key={name}>
                    <span>{name}</span>
                  </th>
                ))}
              {!atStep &&
                table.columns.map((c) => (
                  <th key={c.name} className={column === c.name ? 'selected' : ''} onClick={() => setColumn(c.name)}>
                    <div className="row" style={{ gap: 4 }}>
                      <span>{c.name}</span>
                      <select
                        aria-label={`Type of ${c.name}`}
                        value={c.override ?? c.type}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setOverride(c.name, e.target.value as DataType)}
                        style={{ fontSize: 11, padding: '0 2px' }}
                      >
                        {TYPES.map((t) => (
                          <option key={t.value} value={t.value}>
                            {t.label}
                            {t.value === c.type && c.override ? ' (detected)' : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </th>
                ))}
            </tr>
          </thead>
          <tbody>
            {preview?.rows.map((r, i) => (
              <tr key={i}>
                {r.map((v, j) => {
                  const col = atStep ? undefined : table.columns[j];
                  const t = col ? (col.override ?? col.type) : typeof v === 'number' ? 'number' : 'string';
                  const num = t === 'integer' || t === 'number';
                  return (
                    <td key={j} className={v === null ? 'null' : num ? 'num' : ''}>
                      {v === null ? 'null' : num && typeof v === 'number' ? String(v) : formatValue(v, t)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {preview && preview.total > preview.rows.length && (
          <div className="row" style={{ padding: 10 }}>
            <span className="muted">
              Showing {preview.rows.length.toLocaleString('en-US')} of {preview.total.toLocaleString('en-US')} rows.
            </span>
            {limit < 1000 && <button onClick={() => setLimit(1000)}>Show 1,000</button>}
          </div>
        )}
      </div>
      {column && !atStep && table.columns.some((c) => c.name === column) ? (
        <Profile key={column + typesKey} table={table} column={column} />
      ) : (
        <aside className="profile faint">{atStep ? 'Column profiles describe the result of every step.' : 'Click a column heading to see its profile.'}</aside>
      )}
    </div>
  );
}

function Profile({ table, column }: { table: TableDef; column: string }): React.JSX.Element {
  const [p, setP] = useState<ColumnProfile | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const col = table.columns.find((c) => c.name === column);
  useEffect(() => {
    let alive = true;
    window.ontology
      .profile(table, column)
      .then((r) => alive && setP(r))
      .catch((e: Error) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [table, column]);
  const t = col?.override ?? col?.type ?? 'string';
  const max = p ? Math.max(1, ...p.histogram.map((h) => h.count)) : 1;
  return (
    <aside className="profile" data-testid="profile">
      <div>
        <h3>Column profile</h3>
        <h2 style={{ marginTop: 4, wordBreak: 'break-word' }}>{column}</h2>
        <div className="faint" style={{ marginTop: 2 }}>
          Imported as {col?.sourceType}
          {col?.override ? `, shown as ${t}` : ''}
        </div>
      </div>
      {err && <div className="banner error">{err}</div>}
      {p && (
        <>
          <dl className="stat-grid">
            <dt>Rows</dt>
            <dd>{p.total.toLocaleString('en-US')}</dd>
            <dt>Nulls</dt>
            <dd>
              {p.nulls.toLocaleString('en-US')} ({p.total ? ((p.nulls / p.total) * 100).toFixed(1) : 0}%)
            </dd>
            <dt>Distinct</dt>
            <dd>{p.distinct.toLocaleString('en-US')}</dd>
            <dt>Min</dt>
            <dd title={String(p.min)}>{formatValue(p.min, t)}</dd>
            <dt>Max</dt>
            <dd title={String(p.max)}>{formatValue(p.max, t)}</dd>
          </dl>
          <div className="col" style={{ gap: 3 }}>
            <h3>{p.histogramKind === 'bins' ? 'Distribution' : 'Most common values'}</h3>
            {p.histogram.map((h, i) => (
              <div className="hist-bar" key={i} title={`${h.label}: ${h.count}`}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.label}</span>
                <div className="bar" style={{ width: `${(h.count / max) * 100}%` }} />
                <span className="muted" style={{ textAlign: 'right' }}>
                  {h.count.toLocaleString('en-US')}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
