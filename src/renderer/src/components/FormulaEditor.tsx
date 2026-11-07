import { useMemo, useRef, useState } from 'react';
import { FormulaError, lineCol } from '@shared/formula/ast';
import { ALL_FUNCTIONS, checkFormula } from '@shared/formula/check';
import type { CalcDef } from '@shared/types';
import { newId } from '../ids';
import { clearQueryCache } from '../query';
import { useStore } from '../store';
import { Modal } from './Modal';

const SNIPPETS: Record<string, string> = {
  IF: 'IF  THEN  ELSE  END',
  CASE: 'CASE  WHEN  THEN  ELSE  END',
  FIXED: '{FIXED [] : SUM([])}',
  INCLUDE: '{INCLUDE [] : SUM([])}',
  EXCLUDE: '{EXCLUDE [] : SUM([])}'
};

const HELP: Record<string, string> = {
  SUM: 'SUM(number)',
  AVG: 'AVG(number)',
  MIN: 'MIN(value)',
  MAX: 'MAX(value)',
  COUNT: 'COUNT(value): non-null values',
  COUNTD: 'COUNTD(value): distinct values',
  MEDIAN: 'MEDIAN(number)',
  ISNULL: 'ISNULL(value)',
  IFNULL: 'IFNULL(value, fallback)',
  LEFT: 'LEFT(text, count)',
  RIGHT: 'RIGHT(text, count)',
  UPPER: 'UPPER(text)',
  LOWER: 'LOWER(text)',
  TRIM: 'TRIM(text)',
  CONTAINS: 'CONTAINS(text, search)',
  REPLACE: 'REPLACE(text, from, to)',
  YEAR: 'YEAR(date)',
  QUARTER: 'QUARTER(date)',
  MONTH: 'MONTH(date)',
  DAY: 'DAY(date)',
  DATETRUNC: "DATETRUNC('month', date)",
  DATEADD: "DATEADD('day', 7, date)",
  DATEDIFF: "DATEDIFF('day', start, end)",
  TODAY: 'TODAY()',
  ABS: 'ABS(number)',
  ROUND: 'ROUND(number, decimals)',
  FLOOR: 'FLOOR(number)',
  CEIL: 'CEIL(number)',
  RUNNING_SUM: 'RUNNING_SUM(SUM([x])): running total along the view',
  PERCENT_OF_TOTAL: 'PERCENT_OF_TOTAL(SUM([x]))',
  RANK: 'RANK(SUM([x])): 1 is the largest',
  LAG: 'LAG(SUM([x]), 1): the previous value'
};

export function FormulaEditor({ calc, onClose, onSaved }: { calc?: CalcDef; onClose: () => void; onSaved?: (c: CalcDef) => void }): React.JSX.Element {
  const model = useStore((s) => s.project.model);
  const update = useStore((s) => s.update);
  const [name, setName] = useState(calc?.name ?? 'New calculation');
  const [text, setText] = useState(calc?.formula ?? '');
  const ta = useRef<HTMLTextAreaElement>(null);
  const id = calc?.id ?? null;

  const check = useMemo(() => {
    if (!text.trim()) return null;
    try {
      // Check against the model with this calculation's current name, so self references are caught.
      const m = { ...model, calcs: model.calcs.filter((c) => c.id !== id).concat(id ? [{ id, name, formula: text }] : []) };
      return { ok: true as const, r: checkFormula(text, m, id ?? undefined) };
    } catch (e) {
      if (e instanceof FormulaError) return { ok: false as const, e };
      return { ok: false as const, e: new FormulaError(String(e), 0, 0) };
    }
  }, [text, model, id, name]);

  const nameTaken = model.calcs.some((c) => c.id !== id && c.name.toLowerCase() === name.trim().toLowerCase());
  const columnClash = model.tables.some((t) => t.columns.some((c) => c.name.toLowerCase() === name.trim().toLowerCase()));

  const insert = (s: string): void => {
    const el = ta.current;
    if (!el) return setText(text + s);
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = text.slice(0, start) + s + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = start + s.length;
    });
  };

  const showError = (): void => {
    if (!check || check.ok || !ta.current) return;
    ta.current.focus();
    ta.current.setSelectionRange(check.e.start, Math.max(check.e.end, check.e.start + 1));
  };

  const save = (): void => {
    const def: CalcDef = { id: id ?? newId('k'), name: name.trim(), formula: text };
    update((p) => {
      const existing = p.model.calcs.find((c) => c.id === def.id);
      if (existing) Object.assign(existing, def);
      else p.model.calcs.push(def);
    });
    clearQueryCache();
    onSaved?.(def);
    onClose();
  };

  const kind = check?.ok
    ? check.r.level === 'agg' || check.r.level === 'tcalc'
      ? 'Measure (aggregate)'
      : check.r.level === 'lod'
        ? 'Measure (INCLUDE/EXCLUDE, aggregated when used)'
        : 'Calculated column (row level)'
    : '';

  return (
    <Modal
      title={calc ? `Edit ${calc.name}` : 'New calculation'}
      onClose={onClose}
      wide
      footer={
        <>
          <span className="grow muted">{check?.ok ? `${kind}, ${check.r.vtype}` : ''}</span>
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!check?.ok || !name.trim() || nameTaken} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="formula-layout">
        <div className="col">
          <label className="col" style={{ gap: 4 }}>
            <span className="muted">Name</span>
            <input aria-label="Calculation name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          {nameTaken && <div className="banner error">Another calculation already has this name.</div>}
          {!nameTaken && columnClash && (
            <div className="banner warning">A column has the same name. In formulas, [{name.trim()}] will refer to this calculation.</div>
          )}
          <textarea
            ref={ta}
            aria-label="Formula"
            className="formula-input"
            spellCheck={false}
            value={text}
            placeholder="For example: SUM([Profit]) / SUM([Sales])"
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          {check && !check.ok && (
            <div className="banner error formula-error" data-testid="formula-error">
              <span className="grow">
                {(() => {
                  const { line, col } = lineCol(text, check.e.start);
                  return `Line ${line}, column ${col}: ${check.e.message}`;
                })()}
              </span>
              <button className="small" onClick={showError}>
                Show
              </button>
            </div>
          )}
          {check?.ok && <div className="banner info">The formula is valid.</div>}
          <h3>Functions</h3>
          <div className="fn-list">
            {[...ALL_FUNCTIONS, 'IF', 'CASE', 'FIXED', 'INCLUDE', 'EXCLUDE'].map((f) => (
              <button key={f} title={HELP[f] ?? f} onClick={() => insert(SNIPPETS[f] ?? `${f}()`)}>
                {f}
              </button>
            ))}
          </div>
          <p className="faint" style={{ margin: 0 }}>
            Fields go in square brackets: [Sales] or [Orders].[Sales]. Text goes in quotes. Dates look like #2024-12-31#. Division by zero gives null.
          </p>
        </div>
        <div className="col">
          <h3>Fields</h3>
          <div className="formula-fields">
            {model.tables.map((t) => (
              <div key={t.id}>
                <div className="field-group-title">{t.name}</div>
                {t.columns.map((c) => {
                  const ambiguous = model.tables.filter((x) => x.columns.some((y) => y.name.toLowerCase() === c.name.toLowerCase())).length > 1;
                  const ref = ambiguous ? `[${t.name.replace(/]/g, ']]')}].[${c.name.replace(/]/g, ']]')}]` : `[${c.name.replace(/]/g, ']]')}]`;
                  return (
                    <button key={c.name} onClick={() => insert(ref)}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            ))}
            {model.calcs.length > 0 && <div className="field-group-title">Calculations</div>}
            {model.calcs
              .filter((c) => c.id !== id)
              .map((c) => (
                <button key={c.id} onClick={() => insert(`[${c.name.replace(/]/g, ']]')}]`)}>
                  {c.name}
                </button>
              ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
