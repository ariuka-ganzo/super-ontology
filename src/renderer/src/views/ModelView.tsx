import { useMemo, useState } from 'react';
import { calcInfo } from '@shared/formula/check';
import { cardinalityLabel, suggestRelationships, type RelationshipSuggestion } from '@shared/model/relationships';
import type { CalcDef, Relationship } from '@shared/types';
import { FormulaEditor } from '../components/FormulaEditor';
import { newId } from '../ids';
import { clearQueryCache } from '../query';
import { useStore } from '../store';

export function ModelView(): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const update = useStore((s) => s.update);
  const toast = useStore((s) => s.toast);
  const [editing, setEditing] = useState<CalcDef | 'new' | null>(null);
  const suggestions = useMemo(() => suggestRelationships(model), [model]);
  const tableName = (id: string): string => model.tables.find((t) => t.id === id)?.name ?? id;
  const keys = new Set(model.relationships.flatMap((r) => [`${r.fromTable}:${r.fromColumn}`, `${r.toTable}:${r.toColumn}`]));

  const addRelationship = async (s: Omit<Relationship, 'id' | 'cardinality'>): Promise<void> => {
    try {
      const c = await window.facet.cardinality(model, s);
      update((p) => {
        p.model.relationships.push({ ...s, id: newId('r'), cardinality: c.cardinality });
      });
      clearQueryCache();
      if (c.cardinality === 'many-to-many')
        toast(
          'warning',
          `${tableName(s.fromTable)}.${s.fromColumn} and ${tableName(s.toTable)}.${s.toColumn} are not unique on either side. This many-to-many relationship can multiply rows and inflate totals.`
        );
      if (c.matchRate < 0.5)
        toast('warning', `Only ${(c.matchRate * 100).toFixed(0)}% of ${tableName(s.fromTable)} rows find a match. Check that these are the right columns.`);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  };

  return (
    <div className="view">
      <div className="view-header">
        <h2 className="grow">Model</h2>
        <button className="primary" onClick={() => setEditing('new')} disabled={model.tables.length === 0}>
          New calculation
        </button>
      </div>
      <div className="view-body">
        <div className="model-layout">
          {model.tables.length === 0 && <p className="muted">Import data first. Tables and their relationships appear here.</p>}
          <div className="table-cards">
            {model.tables.map((t) => (
              <div className="panel table-card" key={t.id} data-testid="table-card">
                <header>
                  <span>{t.name}</span>
                  <span className="faint">{t.rowCount.toLocaleString('en-US')}</span>
                </header>
                <ul>
                  {t.columns.map((c) => (
                    <li key={c.name} className={keys.has(`${t.id}:${c.name}`) ? 'key' : ''}>
                      <span>{c.name}</span>
                      <span className="type-badge">{c.override ?? c.type}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {model.tables.length > 1 && (
            <section className="col">
              <h3>Relationships</h3>
              {model.relationships.length === 0 && <p className="muted">No relationships yet. Each view can only use tables connected by relationships.</p>}
              <div className="rel-list">
                {model.relationships.map((r) => (
                  <div className="panel rel" key={r.id} data-testid="relationship">
                    <span>
                      <b>{tableName(r.fromTable)}</b>.{r.fromColumn}
                    </span>
                    <span className="faint">→</span>
                    <span>
                      <b>{tableName(r.toTable)}</b>.{r.toColumn}
                    </span>
                    <span className={`card-badge${r.cardinality === 'many-to-many' ? ' warn' : ''}`}>{cardinalityLabel(r)}</span>
                    {r.cardinality === 'many-to-many' && <span className="banner warning">Can multiply rows and inflate totals</span>}
                    <span className="spacer" />
                    <button
                      className="small danger"
                      onClick={() => {
                        update((p) => {
                          p.model.relationships = p.model.relationships.filter((x) => x.id !== r.id);
                        });
                        clearQueryCache();
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
              {suggestions.length > 0 && (
                <>
                  <h3 style={{ marginTop: 8 }}>Suggested</h3>
                  {suggestions.map((s) => (
                    <Suggestion
                      key={`${s.fromTable}${s.fromColumn}${s.toTable}${s.toColumn}`}
                      s={s}
                      tableName={tableName}
                      onAdd={() => void addRelationship(s)}
                    />
                  ))}
                </>
              )}
              <AddRelationship onAdd={(r) => void addRelationship(r)} />
            </section>
          )}

          {model.tables.length > 0 && (
            <section className="col">
              <h3>Calculations</h3>
              {model.calcs.length === 0 && <p className="muted">Calculations are saved formulas: calculated columns (row level) or measures (aggregates).</p>}
              {model.calcs.map((c) => {
                const info = calcInfo(model, c.id);
                return (
                  <div className="panel rel" key={c.id}>
                    <b>{c.name}</b>
                    <code className="mono grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.formula}
                    </code>
                    {info.ok ? (
                      <span className="card-badge">{info.level === 'row' || info.level === 'const' ? 'Column' : 'Measure'}</span>
                    ) : (
                      <span className="card-badge warn" title={info.error?.message}>
                        Error
                      </span>
                    )}
                    <button className="small" onClick={() => setEditing(c)}>
                      Edit
                    </button>
                    <button
                      className="small danger"
                      onClick={() => {
                        update((p) => {
                          p.model.calcs = p.model.calcs.filter((x) => x.id !== c.id);
                        });
                        clearQueryCache();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </section>
          )}
        </div>
      </div>
      {editing && <FormulaEditor calc={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Suggestion({ s, tableName, onAdd }: { s: RelationshipSuggestion; tableName: (id: string) => string; onAdd: () => void }): React.JSX.Element {
  return (
    <div className="panel rel" data-testid="suggestion">
      <span>
        <b>{tableName(s.fromTable)}</b>.{s.fromColumn}
      </span>
      <span className="faint">→</span>
      <span>
        <b>{tableName(s.toTable)}</b>.{s.toColumn}
      </span>
      <span className="faint grow">{s.reason}</span>
      <button className="small primary" onClick={onAdd}>
        Add
      </button>
    </div>
  );
}

function AddRelationship({ onAdd }: { onAdd: (r: Omit<Relationship, 'id' | 'cardinality'>) => void }): React.JSX.Element {
  const tables = useStore((s) => s.project.model.tables);
  const [from, setFrom] = useState({ table: tables[0]?.id ?? '', column: '' });
  const [to, setTo] = useState({ table: tables[1]?.id ?? '', column: '' });
  const cols = (id: string): string[] => tables.find((t) => t.id === id)?.columns.map((c) => c.name) ?? [];
  const ready = from.table && to.table && from.table !== to.table && from.column && to.column;
  return (
    <div className="panel rel">
      <span className="muted">Add:</span>
      <select aria-label="From table" value={from.table} onChange={(e) => setFrom({ table: e.target.value, column: '' })}>
        {tables.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select aria-label="From column" value={from.column} onChange={(e) => setFrom({ ...from, column: e.target.value })}>
        <option value="">Column…</option>
        {cols(from.table).map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <span className="faint">→</span>
      <select aria-label="To table" value={to.table} onChange={(e) => setTo({ table: e.target.value, column: '' })}>
        {tables.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <select aria-label="To column" value={to.column} onChange={(e) => setTo({ ...to, column: e.target.value })}>
        <option value="">Column…</option>
        {cols(to.table).map((c) => (
          <option key={c}>{c}</option>
        ))}
      </select>
      <button
        className="small"
        disabled={!ready}
        onClick={() => onAdd({ fromTable: from.table, fromColumn: from.column, toTable: to.table, toColumn: to.column })}
      >
        Add relationship
      </button>
    </div>
  );
}
