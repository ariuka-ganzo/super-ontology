// Compiles a table's data cleaning steps (TableDef.steps) to one SQL query.
//
// Each step wraps the previous query: SELECT … FROM (previous) AS s. Every identifier is quoted and
// every value is a bound parameter, as in the view compiler. Steps are checked against the columns
// as they are after the previous steps, and compiling stops at the first step that does not fit,
// so the result is always the longest valid prefix plus a plain-language error for that step.
import { Params, compactParams, quoteIdent as q, sqlType } from '../compiler/sql';
import type { DataType, PrepStep, Scalar, TableDef } from '../types';

export interface PrepColumn {
  name: string;
  type: DataType;
}

/** A relation steps can read from: the raw import, or another table for an append step. */
export interface PrepSource {
  /** SQL for the relation, already quoted. */
  ref: string;
  columns: PrepColumn[];
}

export interface PrepError {
  stepId: string;
  /** Zero-based position of the step. */
  index: number;
  message: string;
}

export interface CompiledPrep {
  sql: string;
  params: Scalar[];
  /** Columns of the result. */
  columns: PrepColumn[];
  /** How many steps the SQL includes. Less than the number of steps when one failed. */
  applied: number;
  error?: PrepError;
}

class StepError extends Error {}

const TEXT_ONLY = 'works on text columns. Add a "Change type" step to make it text first';

function find(cols: PrepColumn[], name: string): PrepColumn {
  const c = cols.find((x) => x.name === name);
  if (!c) throw new StepError(`There is no column named "${name}" at this point. An earlier step may have renamed or removed it`);
  return c;
}

/** Checks a new column name. DuckDB compares column names without regard to case. */
function checkNewName(name: string, taken: string[]): string {
  const n = name.trim();
  if (!n) throw new StepError('The new column name is empty');
  if (n.length > 255) throw new StepError('The new column name is too long');
  if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) throw new StepError(`There is already a column named "${n}"`);
  return n;
}

function isText(c: PrepColumn): boolean {
  return c.type === 'string';
}

/** A value typed in the step form, converted to the column's type. Checked here so a typo is an error, not an empty result. */
function typedValue(p: Params, value: Scalar | undefined, col: PrepColumn): string {
  if (value === undefined || value === null || value === '') throw new StepError('Enter a value');
  const s = String(value).trim();
  if ((col.type === 'integer' || col.type === 'number') && !Number.isFinite(Number(s))) throw new StepError(`"${s}" is not a number`);
  if (col.type === 'integer' && !Number.isInteger(Number(s))) throw new StepError(`"${s}" is not a whole number`);
  if (col.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new StepError(`Enter dates as YYYY-MM-DD, for example 2024-12-31`);
  if (col.type === 'datetime' && !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(s))
    throw new StepError('Enter dates and times as YYYY-MM-DD HH:MM, for example 2024-12-31 18:30');
  if (col.type === 'boolean' && !/^(true|false)$/i.test(s)) throw new StepError('Enter true or false');
  return `CAST(${p.add(col.type === 'string' ? String(value) : s, 'VARCHAR')} AS ${sqlType(col.type)})`;
}

function blank(col: PrepColumn): string {
  return isText(col) ? `(${q(col.name)} IS NULL OR trim(${q(col.name)}) = '')` : `(${q(col.name)} IS NULL)`;
}

interface Step {
  sql: string;
  cols: PrepColumn[];
}

function applyStep(step: PrepStep, cols: PrepColumn[], from: string, p: Params, other: (tableId: string) => PrepSource | undefined, selfId: string): Step {
  const select = (list: string[], out: PrepColumn[], tail = ''): Step => ({ sql: `SELECT ${list.join(', ')} FROM ${from} AS s${tail}`, cols: out });
  const all = (): string[] => cols.map((c) => q(c.name));
  const replaceCol = (name: string, expr: string, type: DataType): Step =>
    select(
      cols.map((c) => (c.name === name ? `${expr} AS ${q(c.name)}` : q(c.name))),
      cols.map((c) => (c.name === name ? { name, type } : c))
    );

  switch (step.kind) {
    case 'rename': {
      const c = find(cols, step.column);
      const to = checkNewName(
        step.to,
        cols.filter((x) => x !== c).map((x) => x.name)
      );
      return select(
        cols.map((x) => (x === c ? `${q(x.name)} AS ${q(to)}` : q(x.name))),
        cols.map((x) => (x === c ? { name: to, type: x.type } : x))
      );
    }
    case 'remove': {
      for (const n of step.columns) find(cols, n);
      const left = cols.filter((c) => !step.columns.includes(c.name));
      if (!left.length) throw new StepError('This would remove every column');
      return select(
        left.map((c) => q(c.name)),
        left
      );
    }
    case 'keep': {
      const kept = [...new Set(step.columns)].map((n) => find(cols, n));
      if (!kept.length) throw new StepError('Choose at least one column to keep');
      return select(
        kept.map((c) => q(c.name)),
        kept
      );
    }
    case 'changeType': {
      const c = find(cols, step.column);
      // Values that cannot be converted become empty (null) rather than failing the whole table.
      return replaceCol(c.name, `TRY_CAST(${q(c.name)} AS ${sqlType(step.to)})`, step.to);
    }
    case 'filter': {
      const c = find(cols, step.column);
      const col = q(c.name);
      const lowerText = `lower(CAST(${col} AS VARCHAR))`;
      const needle = (): string => {
        if (step.value === undefined || step.value === null || step.value === '') throw new StepError('Enter the text to look for');
        return `lower(${p.add(String(step.value), 'VARCHAR')})`;
      };
      let where: string;
      switch (step.op) {
        case 'blank':
          where = blank(c);
          break;
        case 'notBlank':
          where = `NOT ${blank(c)}`;
          break;
        case 'contains':
          where = `strpos(${lowerText}, ${needle()}) > 0`;
          break;
        case 'notContains':
          where = `(${col} IS NULL OR strpos(${lowerText}, ${needle()}) = 0)`;
          break;
        case 'startsWith':
          where = `starts_with(${lowerText}, ${needle()})`;
          break;
        case '!=':
          // Keeps empty values, as "does not equal" reads in plain language.
          where = `${col} IS DISTINCT FROM ${typedValue(p, step.value, c)}`;
          break;
        default:
          where = `${col} ${step.op} ${typedValue(p, step.value, c)}`;
      }
      return select(all(), cols, ` WHERE ${where}`);
    }
    case 'replace': {
      const c = find(cols, step.column);
      if (!isText(c)) throw new StepError(`Replace ${TEXT_ONLY}`);
      if (!step.find) throw new StepError('Enter the text to find');
      const f = p.add(step.find, 'VARCHAR');
      const w = p.add(step.with, 'VARCHAR');
      const col = q(c.name);
      return replaceCol(c.name, step.whole ? `CASE WHEN ${col} = ${f} THEN ${w} ELSE ${col} END` : `replace(${col}, ${f}, ${w})`, 'string');
    }
    case 'text': {
      const c = find(cols, step.column);
      if (!isText(c)) throw new StepError(`${step.op === 'trim' ? 'Trim' : 'Changing case'} ${TEXT_ONLY}`);
      return replaceCol(c.name, `${step.op}(${q(c.name)})`, 'string');
    }
    case 'fillBlank': {
      const c = find(cols, step.column);
      return replaceCol(c.name, `CASE WHEN ${blank(c)} THEN ${typedValue(p, step.value, c)} ELSE ${q(c.name)} END`, c.type);
    }
    case 'split': {
      const c = find(cols, step.column);
      if (!step.separator) throw new StepError('Enter the separator to split at');
      if (step.into.length < 2) throw new StepError('Name at least two new columns');
      const others = cols.filter((x) => x !== c).map((x) => x.name);
      const names: string[] = [];
      for (const n of step.into) names.push(checkNewName(n, [...others, ...names]));
      const sep = p.add(step.separator, 'VARCHAR');
      const src = `CAST(${q(c.name)} AS VARCHAR)`;
      const parts = names.map((n, i) => `NULLIF(split_part(${src}, ${sep}, ${i + 1}), '') AS ${q(n)}`);
      return select(
        cols.flatMap((x) => (x === c ? parts : [q(x.name)])),
        cols.flatMap((x) => (x === c ? names.map((name) => ({ name, type: 'string' as const })) : [x]))
      );
    }
    case 'merge': {
      const merged = [...new Set(step.columns)].map((n) => find(cols, n));
      if (merged.length < 2) throw new StepError('Choose at least two columns to merge');
      const to = checkNewName(
        step.to,
        cols.filter((x) => !merged.includes(x)).map((x) => x.name)
      );
      const expr = `concat_ws(${p.add(step.separator, 'VARCHAR')}, ${merged.map((c) => `CAST(${q(c.name)} AS VARCHAR)`).join(', ')}) AS ${q(to)}`;
      const at = cols.indexOf(merged[0]);
      const list: string[] = [];
      const out: PrepColumn[] = [];
      cols.forEach((c, i) => {
        if (i === at) {
          list.push(expr);
          out.push({ name: to, type: 'string' });
        } else if (!merged.includes(c)) {
          list.push(q(c.name));
          out.push(c);
        }
      });
      return select(list, out);
    }
    case 'dedupe': {
      if (!step.columns?.length) return { sql: `SELECT DISTINCT ${all().join(', ')} FROM ${from} AS s`, cols };
      const keys = [...new Set(step.columns)].map((n) => q(find(cols, n).name));
      return { sql: `SELECT DISTINCT ON (${keys.join(', ')}) ${all().join(', ')} FROM ${from} AS s`, cols };
    }
    case 'removeBlankRows':
      return select(all(), cols, ` WHERE NOT (${cols.map(blank).join(' AND ')})`);
    case 'keepTop':
      if (!Number.isInteger(step.n) || step.n < 1) throw new StepError('Enter a whole number of rows, 1 or more');
      return select(all(), cols, ` LIMIT ${p.add(step.n, 'BIGINT')}`);
    case 'append': {
      if (step.tableId === selfId) throw new StepError('A table cannot be appended to itself');
      const o = other(step.tableId);
      if (!o) throw new StepError('The table to append is not loaded. It may have been removed from the project');
      const extra = o.columns.filter((x) => !cols.some((c) => c.name.toLowerCase() === x.name.toLowerCase()));
      // Columns are matched by name; a column missing on one side is empty there.
      return { sql: `SELECT ${all().join(', ')} FROM ${from} AS s UNION ALL BY NAME SELECT * FROM ${o.ref}`, cols: [...cols, ...extra] };
    }
  }
}

/** Compiles steps over `base`. `other` resolves the tables append steps read from. */
export function compilePrep(base: PrepSource, steps: PrepStep[], other: (tableId: string) => PrepSource | undefined, selfId: string): CompiledPrep {
  const p = new Params();
  let sql = `SELECT * FROM ${base.ref}`;
  let cols = base.columns;
  let applied = 0;
  let error: PrepError | undefined;
  for (const [index, step] of steps.entries()) {
    const before = p.values.length;
    try {
      const r = applyStep(step, cols, `(${sql})`, p, other, selfId);
      sql = r.sql;
      cols = r.cols;
      applied++;
    } catch (e) {
      // Drop values the failed step added, then stop.
      p.values.length = before;
      error = { stepId: step.id, index, message: e instanceof StepError ? e.message : String(e) };
      break;
    }
  }
  const { sql: out, params } = compactParams(sql, p.values);
  return { sql: out, params, columns: cols, applied, error };
}

const OPS: Record<string, string> = {
  '=': 'equals',
  '!=': 'does not equal',
  '>': 'is greater than',
  '>=': 'is at least',
  '<': 'is less than',
  '<=': 'is at most',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with'
};

const TYPE_LABELS: Record<DataType, string> = {
  string: 'text',
  integer: 'whole number',
  number: 'decimal',
  boolean: 'true/false',
  date: 'date',
  datetime: 'date and time'
};

const list = (names: string[]): string => names.join(', ');

/** A one-line, plain-language description of a step for the steps list. */
export function describeStep(step: PrepStep, tables: Pick<TableDef, 'id' | 'name'>[]): string {
  switch (step.kind) {
    case 'rename':
      return `Rename ${step.column} to ${step.to}`;
    case 'remove':
      return `Remove ${list(step.columns)}`;
    case 'keep':
      return `Keep only ${list(step.columns)}`;
    case 'changeType':
      return `Change ${step.column} to ${TYPE_LABELS[step.to]}`;
    case 'filter':
      if (step.op === 'blank') return `Keep rows where ${step.column} is blank`;
      if (step.op === 'notBlank') return `Remove rows where ${step.column} is blank`;
      return `Keep rows where ${step.column} ${OPS[step.op]} ${String(step.value ?? '')}`;
    case 'replace':
      return `Replace ${step.whole ? 'the value' : ''} "${step.find}" with "${step.with}" in ${step.column}`.replace('  ', ' ');
    case 'text':
      return step.op === 'trim' ? `Trim spaces in ${step.column}` : `Make ${step.column} ${step.op === 'upper' ? 'UPPER' : 'lower'} case`;
    case 'fillBlank':
      return `Fill blanks in ${step.column} with ${String(step.value)}`;
    case 'split':
      return `Split ${step.column} at "${step.separator}" into ${list(step.into)}`;
    case 'merge':
      return `Merge ${list(step.columns)} into ${step.to}`;
    case 'dedupe':
      return step.columns?.length ? `Remove duplicates of ${list(step.columns)}` : 'Remove duplicate rows';
    case 'removeBlankRows':
      return 'Remove blank rows';
    case 'keepTop':
      return `Keep the first ${step.n.toLocaleString('en-US')} rows`;
    case 'append':
      return `Append rows from ${tables.find((t) => t.id === step.tableId)?.name ?? 'a removed table'}`;
  }
}

/** Ids of the tables a table's steps read from. */
export function appendSources(steps: PrepStep[] | undefined): string[] {
  return (steps ?? []).flatMap((s) => (s.kind === 'append' ? [s.tableId] : []));
}
