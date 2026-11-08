import { useState } from 'react';
import { describeStep } from '@shared/prep/prep';
import type { DataType, PrepFilterOp, PrepStep, PrepStepKind, TableDef } from '@shared/types';
import { newId } from '../ids';
import { useStore } from '../store';
import { Modal } from './Modal';
import { MenuItem, Popover } from './Popover';

const KINDS: { kind: PrepStepKind; label: string }[] = [
  { kind: 'rename', label: 'Rename a column' },
  { kind: 'remove', label: 'Remove columns' },
  { kind: 'keep', label: 'Keep only some columns' },
  { kind: 'changeType', label: 'Change a column’s type' },
  { kind: 'filter', label: 'Filter rows' },
  { kind: 'replace', label: 'Replace values' },
  { kind: 'text', label: 'Trim or change case' },
  { kind: 'fillBlank', label: 'Fill blanks' },
  { kind: 'split', label: 'Split a column' },
  { kind: 'merge', label: 'Merge columns' },
  { kind: 'dedupe', label: 'Remove duplicates' },
  { kind: 'removeBlankRows', label: 'Remove blank rows' },
  { kind: 'keepTop', label: 'Keep the first rows' },
  { kind: 'append', label: 'Append another table' }
];

const TYPES: { value: DataType; label: string }[] = [
  { value: 'string', label: 'Text' },
  { value: 'integer', label: 'Whole number' },
  { value: 'number', label: 'Decimal' },
  { value: 'boolean', label: 'True/False' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date and time' }
];

const FILTER_OPS: { value: PrepFilterOp; label: string }[] = [
  { value: '=', label: 'equals' },
  { value: '!=', label: 'does not equal' },
  { value: '>', label: 'is greater than' },
  { value: '>=', label: 'is at least' },
  { value: '<', label: 'is less than' },
  { value: '<=', label: 'is at most' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'notBlank', label: 'is not blank' },
  { value: 'blank', label: 'is blank' }
];

/** The list of a table's cleaning steps, with controls to add, reorder and remove them. */
export function StepsPanel({
  table,
  selected,
  onSelect,
  column
}: {
  table: TableDef;
  /** The step whose result the grid shows, or null for the final result. */
  selected: string | null;
  onSelect: (stepId: string | null) => void;
  /** The column selected in the grid, used as the default for a new step. */
  column: string | null;
}): React.JSX.Element {
  const update = useStore((s) => s.update);
  const tables = useStore((s) => s.project.model.tables);
  const error = useStore((s) => s.stepErrors[table.id]);
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [adding, setAdding] = useState<PrepStepKind | null>(null);
  const steps = table.steps ?? [];

  const edit = (fn: (steps: PrepStep[]) => PrepStep[]): void =>
    update((p) => {
      const t = p.model.tables.find((x) => x.id === table.id);
      if (t) t.steps = fn(t.steps ?? []);
    });
  const move = (i: number, by: number): void =>
    edit((list) => {
      const next = [...list];
      const [s] = next.splice(i, 1);
      next.splice(i + by, 0, s);
      return next;
    });

  return (
    <aside className="steps" data-testid="steps">
      <div className="row">
        <h3 className="grow">Cleaning steps</h3>
        <button className="small" onClick={(e) => setMenu(e.currentTarget)} data-testid="add-step">
          + Add step
        </button>
      </div>
      <button className={`step${selected === null ? ' active' : ''}`} onClick={() => onSelect(null)} title="Show the data after every step">
        <span className="step-n">▤</span>
        <span className="grow">{steps.length ? 'Result of all steps' : 'Imported data'}</span>
      </button>
      {steps.length === 0 && <p className="faint">Add steps to rename, filter, split or tidy the data. The file itself is never changed.</p>}
      {steps.map((s, i) => {
        const failed = error?.stepId === s.id;
        const after = error ? steps.findIndex((x) => x.id === error.stepId) < i : false;
        return (
          <div key={s.id} className={`step${selected === s.id ? ' active' : ''}${failed ? ' failed' : ''}${after ? ' skipped' : ''}`} data-testid="step">
            <button className="step-main" onClick={() => onSelect(s.id)} title={failed ? error.message : 'Show the data after this step'}>
              <span className="step-n">{i + 1}</span>
              <span className="grow">{describeStep(s, tables)}</span>
            </button>
            <span className="step-tools">
              <button className="small ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move step ${i + 1} up`}>
                ↑
              </button>
              <button className="small ghost" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move step ${i + 1} down`}>
                ↓
              </button>
              <button
                className="small ghost"
                onClick={() => {
                  if (selected === s.id) onSelect(null);
                  edit((list) => list.filter((x) => x.id !== s.id));
                }}
                aria-label={`Remove step ${i + 1}`}
              >
                ✕
              </button>
            </span>
            {failed && (
              <div className="step-error" data-testid="step-error">
                {error.message}
              </div>
            )}
          </div>
        );
      })}
      {error && <p className="faint">Steps after the one marked in red are not applied until it is fixed or removed.</p>}
      {menu && (
        <Popover anchor={menu} onClose={() => setMenu(null)}>
          {KINDS.filter((k) => k.kind !== 'append' || tables.length > 1).map((k) => (
            <MenuItem
              key={k.kind}
              onClick={() => {
                setMenu(null);
                setAdding(k.kind);
              }}
            >
              {k.label}
            </MenuItem>
          ))}
        </Popover>
      )}
      {adding && (
        <StepDialog
          kind={adding}
          table={table}
          column={column}
          onClose={() => setAdding(null)}
          onAdd={(step) => {
            edit((list) => [...list, step]);
            onSelect(null);
            setAdding(null);
          }}
        />
      )}
    </aside>
  );
}

function ColumnSelect({
  value,
  onChange,
  columns,
  label = 'Column'
}: {
  value: string;
  onChange: (v: string) => void;
  columns: string[];
  label?: string;
}): React.JSX.Element {
  return (
    <label className="col" style={{ gap: 2 }}>
      <span className="muted">{label}</span>
      <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
        {columns.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColumnChecks({
  value,
  onChange,
  columns,
  label
}: {
  value: string[];
  onChange: (v: string[]) => void;
  columns: string[];
  label: string;
}): React.JSX.Element {
  return (
    <div className="col" style={{ gap: 2 }} role="group" aria-label={label}>
      <span className="muted">{label}</span>
      <div className="col checks">
        {columns.map((c) => (
          <label key={c} className="row">
            <input type="checkbox" checked={value.includes(c)} onChange={() => onChange(value.includes(c) ? value.filter((x) => x !== c) : [...value, c])} />
            <span>{c}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): React.JSX.Element {
  return (
    <label className="col" style={{ gap: 2 }}>
      <span className="muted">{label}</span>
      <input aria-label={label} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** A form for one new step. The engine checks the step when it is applied and reports any problem on the step. */
function StepDialog({
  kind,
  table,
  column,
  onClose,
  onAdd
}: {
  kind: PrepStepKind;
  table: TableDef;
  column: string | null;
  onClose: () => void;
  onAdd: (s: PrepStep) => void;
}): React.JSX.Element {
  const tables = useStore((s) => s.project.model.tables);
  const columns = table.columns.map((c) => c.name);
  const [col, setCol] = useState(column && columns.includes(column) ? column : (columns[0] ?? ''));
  const [cols, setCols] = useState<string[]>(column && columns.includes(column) ? [column] : []);
  const [text, setText] = useState('');
  const [text2, setText2] = useState('');
  const [flag, setFlag] = useState(false);
  const [type, setType] = useState<DataType>('string');
  const [op, setOp] = useState<PrepFilterOp>('=');
  const [textOp, setTextOp] = useState<'trim' | 'upper' | 'lower'>('trim');
  const [other, setOther] = useState(tables.find((t) => t.id !== table.id)?.id ?? '');
  const id = newId('st');
  const label = KINDS.find((k) => k.kind === kind)?.label ?? 'Add step';

  const build = (): PrepStep | null => {
    switch (kind) {
      case 'rename':
        return text.trim() ? { id, kind, column: col, to: text.trim() } : null;
      case 'remove':
      case 'keep':
        return cols.length ? { id, kind, columns: cols } : null;
      case 'changeType':
        return { id, kind, column: col, to: type };
      case 'filter':
        return op === 'blank' || op === 'notBlank' ? { id, kind, column: col, op } : text !== '' ? { id, kind, column: col, op, value: text } : null;
      case 'replace':
        return text ? { id, kind, column: col, find: text, with: text2, whole: flag || undefined } : null;
      case 'text':
        return { id, kind, column: col, op: textOp };
      case 'fillBlank':
        return text !== '' ? { id, kind, column: col, value: text } : null;
      case 'split': {
        const into = text2
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean);
        return text && into.length >= 2 ? { id, kind, column: col, separator: text, into } : null;
      }
      case 'merge':
        return cols.length >= 2 && text2.trim() ? { id, kind, columns: columns.filter((c) => cols.includes(c)), separator: text, to: text2.trim() } : null;
      case 'dedupe':
        return cols.length ? { id, kind, columns: cols } : { id, kind };
      case 'removeBlankRows':
        return { id, kind };
      case 'keepTop': {
        const n = Number(text);
        return Number.isInteger(n) && n >= 1 ? { id, kind, n } : null;
      }
      case 'append':
        return other ? { id, kind, tableId: other } : null;
    }
  };
  const step = build();

  return (
    <Modal
      title={label}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!step} onClick={() => step && onAdd(step)}>
            Add step
          </button>
        </>
      }
    >
      <div className="col" data-testid="step-dialog">
        {kind === 'rename' && (
          <>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <Field label="New name" value={text} onChange={setText} />
          </>
        )}
        {(kind === 'remove' || kind === 'keep') && (
          <ColumnChecks value={cols} onChange={setCols} columns={columns} label={kind === 'remove' ? 'Columns to remove' : 'Columns to keep'} />
        )}
        {kind === 'changeType' && (
          <>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <label className="col" style={{ gap: 2 }}>
              <span className="muted">New type</span>
              <select aria-label="New type" value={type} onChange={(e) => setType(e.target.value as DataType)}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="faint">Values that cannot be converted become blank.</p>
          </>
        )}
        {kind === 'filter' && (
          <>
            <p className="muted">Keep only the rows where:</p>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <label className="col" style={{ gap: 2 }}>
              <span className="muted">Condition</span>
              <select aria-label="Condition" value={op} onChange={(e) => setOp(e.target.value as PrepFilterOp)}>
                {FILTER_OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {op !== 'blank' && op !== 'notBlank' && <Field label="Value" value={text} onChange={setText} placeholder="Dates as YYYY-MM-DD" />}
            {(op === 'contains' || op === 'notContains' || op === 'startsWith') && <p className="faint">Ignores upper and lower case.</p>}
          </>
        )}
        {kind === 'replace' && (
          <>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <Field label="Find" value={text} onChange={setText} />
            <Field label="Replace with" value={text2} onChange={setText2} />
            <label className="row">
              <input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} />
              <span>Only when it is the whole value</span>
            </label>
          </>
        )}
        {kind === 'text' && (
          <>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <label className="col" style={{ gap: 2 }}>
              <span className="muted">Change</span>
              <select aria-label="Change" value={textOp} onChange={(e) => setTextOp(e.target.value as 'trim' | 'upper' | 'lower')}>
                <option value="trim">Trim spaces at the start and end</option>
                <option value="upper">UPPER CASE</option>
                <option value="lower">lower case</option>
              </select>
            </label>
          </>
        )}
        {kind === 'fillBlank' && (
          <>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <Field label="Fill with" value={text} onChange={setText} />
          </>
        )}
        {kind === 'split' && (
          <>
            <ColumnSelect value={col} onChange={setCol} columns={columns} />
            <Field label="Separator" value={text} onChange={setText} placeholder="For example , or - or a space" />
            <Field label="New column names" value={text2} onChange={setText2} placeholder={`${col} 1, ${col} 2`} />
            <p className="faint">Separate the names with commas. The column is split at each separator; parts beyond the names given are dropped.</p>
          </>
        )}
        {kind === 'merge' && (
          <>
            <ColumnChecks value={cols} onChange={setCols} columns={columns} label="Columns to merge, in table order" />
            <Field label="Separator" value={text} onChange={setText} placeholder="For example a space or -" />
            <Field label="New column name" value={text2} onChange={setText2} />
          </>
        )}
        {kind === 'dedupe' && (
          <>
            <ColumnChecks value={cols} onChange={setCols} columns={columns} label="Compare these columns" />
            <p className="faint">
              With none ticked, rows are duplicates only when every column matches. Otherwise one row is kept for each combination of the ticked columns.
            </p>
          </>
        )}
        {kind === 'removeBlankRows' && <p className="muted">Removes rows in which every column is empty.</p>}
        {kind === 'keepTop' && <Field label="Number of rows" value={text} onChange={setText} placeholder="100" />}
        {kind === 'append' && (
          <>
            <label className="col" style={{ gap: 2 }}>
              <span className="muted">Table to append</span>
              <select aria-label="Table to append" value={other} onChange={(e) => setOther(e.target.value)}>
                {tables
                  .filter((t) => t.id !== table.id)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </select>
            </label>
            <p className="faint">Adds its rows below this table’s, matching columns by name. A column that only one table has is blank in the other’s rows.</p>
          </>
        )}
      </div>
    </Modal>
  );
}
