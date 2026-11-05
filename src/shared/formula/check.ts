import type { CalcDef, DataType, FieldRef, Model, Scalar, TableDef } from '../types';
import { FormulaError, type BinaryOp, type LodKind, type Node, type Span } from './ast';
import { parseFormula } from './parser';

/** Value type of an expression. */
export type VType = 'number' | 'string' | 'boolean' | 'date' | 'datetime' | 'null';

/**
 * Evaluation level of an expression.
 * - const: a literal
 * - row: one value per data row (columns, calculated columns, FIXED expressions)
 * - agg: an aggregate, one value per mark
 * - lod: an INCLUDE or EXCLUDE expression, which must be aggregated before it is shown
 * - tcalc: a table calculation over aggregated results
 */
export type Level = 'const' | 'row' | 'agg' | 'lod' | 'tcalc';

interface TBase extends Span {
  vtype: VType;
  level: Level;
}

export type TNode =
  | (TBase & { t: 'lit'; value: Scalar })
  | (TBase & { t: 'col'; table: string; column: string; dataType: DataType })
  | (TBase & { t: 'unary'; op: '-' | 'NOT'; arg: TNode })
  | (TBase & { t: 'binary'; op: BinaryOp; left: TNode; right: TNode })
  | (TBase & { t: 'call'; name: string; args: TNode[] })
  | (TBase & { t: 'if'; branches: { cond: TNode; then: TNode }[]; else?: TNode })
  | (TBase & { t: 'case'; subject: TNode; whens: { match: TNode; then: TNode }[]; else?: TNode })
  | (TBase & { t: 'lod'; kind: LodKind; dims: TNode[]; body: TNode });

export const AGGREGATES = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'MEDIAN']);
export const TABLE_CALCS = new Set(['RUNNING_SUM', 'PERCENT_OF_TOTAL', 'RANK', 'LAG']);
const ROW_FUNCS = [
  'ISNULL',
  'IFNULL',
  'LEFT',
  'RIGHT',
  'UPPER',
  'LOWER',
  'TRIM',
  'CONTAINS',
  'REPLACE',
  'YEAR',
  'QUARTER',
  'MONTH',
  'DAY',
  'DATETRUNC',
  'DATEADD',
  'DATEDIFF',
  'TODAY',
  'ABS',
  'ROUND',
  'FLOOR',
  'CEIL'
];
export const ALL_FUNCTIONS = [...AGGREGATES, ...ROW_FUNCS, ...TABLE_CALCS];

export const DATE_PARTS = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second'] as const;

export function dataTypeToVType(t: DataType): VType {
  if (t === 'integer' || t === 'number') return 'number';
  return t;
}

export function effectiveType(c: { type: DataType; override?: DataType }): DataType {
  return c.override ?? c.type;
}

export interface CheckResult {
  node: TNode;
  vtype: VType;
  level: Level;
}

interface Env {
  model: Model;
  stack: string[];
  cache: Map<string, TNode>;
}

/** Parses and type checks formula text against a model. Throws FormulaError. */
export function checkFormula(text: string, model: Model, selfId?: string): CheckResult {
  const env: Env = { model, stack: selfId ? [selfId] : [], cache: new Map() };
  const node = check(parseFormula(text), env);
  return { node, vtype: node.vtype, level: node.level };
}

export interface CalcInfo {
  ok: boolean;
  vtype?: VType;
  level?: Level;
  error?: FormulaError;
}

/** Type information for a saved calculation, or its error. */
export function calcInfo(model: Model, calcId: string): CalcInfo {
  const calc = model.calcs.find((c) => c.id === calcId);
  if (!calc) return { ok: false, error: new FormulaError('Calculation not found', 0, 0) };
  try {
    const r = checkFormula(calc.formula, model, calc.id);
    return { ok: true, vtype: r.vtype, level: r.level };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e };
    throw e;
  }
}

/** Returns the typed node for a field reference used on a shelf or in a filter. */
export function fieldNode(ref: FieldRef, model: Model): TNode {
  const env: Env = { model, stack: [], cache: new Map() };
  if (ref.kind === 'column') {
    const table = model.tables.find((t) => t.id === ref.table);
    const col = table?.columns.find((c) => c.name === ref.column);
    if (!table || !col) throw new FormulaError(`Field ${ref.column} no longer exists`, 0, 0);
    const dt = effectiveType(col);
    return { t: 'col', table: table.id, column: col.name, dataType: dt, vtype: dataTypeToVType(dt), level: 'row', start: 0, end: 0 };
  }
  const calc = model.calcs.find((c) => c.id === ref.id);
  if (!calc) throw new FormulaError('Calculation no longer exists', 0, 0);
  return calcNode(calc, env, { start: 0, end: 0 });
}

export function fieldLabel(ref: FieldRef, model: Model): string {
  if (ref.kind === 'column') return ref.column;
  return model.calcs.find((c) => c.id === ref.id)?.name ?? 'Missing calculation';
}

function calcNode(calc: CalcDef, env: Env, at: Span): TNode {
  if (env.stack.includes(calc.id))
    throw new FormulaError(`[${calc.name}] refers to itself through other calculations`, at.start, at.end);
  const cached = env.cache.get(calc.id);
  if (cached) return cached;
  env.stack.push(calc.id);
  try {
    const node = check(parseFormula(calc.formula), env);
    env.cache.set(calc.id, node);
    return node;
  } catch (e) {
    if (e instanceof FormulaError && at.end > at.start)
      throw new FormulaError(`Calculation [${calc.name}] has an error: ${e.message}`, at.start, at.end);
    throw e;
  } finally {
    env.stack.pop();
  }
}

function findTable(model: Model, name: string): TableDef | undefined {
  const lower = name.toLowerCase();
  return model.tables.find((t) => t.name.toLowerCase() === lower) ?? model.tables.find((t) => t.id === name);
}

function resolveField(node: Extract<Node, { type: 'field' }>, env: Env): TNode {
  const { model } = env;
  const lower = node.name.toLowerCase();
  if (node.table !== undefined) {
    const table = findTable(model, node.table);
    if (!table) throw new FormulaError(`Unknown table [${node.table}]`, node.start, node.end);
    const col = table.columns.find((c) => c.name.toLowerCase() === lower);
    if (!col) throw new FormulaError(`Table [${table.name}] has no field [${node.name}]`, node.start, node.end);
    const dt = effectiveType(col);
    return { t: 'col', table: table.id, column: col.name, dataType: dt, vtype: dataTypeToVType(dt), level: 'row', start: node.start, end: node.end };
  }
  const calc = model.calcs.find((c) => c.name.toLowerCase() === lower);
  if (calc) {
    const inner = calcNode(calc, env, node);
    return { ...inner, start: node.start, end: node.end };
  }
  const matches: { table: TableDef; name: string; type: DataType }[] = [];
  for (const table of model.tables)
    for (const c of table.columns) if (c.name.toLowerCase() === lower) matches.push({ table, name: c.name, type: effectiveType(c) });
  if (matches.length === 0) {
    const hint = suggest(node.name, [...model.calcs.map((c) => c.name), ...model.tables.flatMap((t) => t.columns.map((c) => c.name))]);
    throw new FormulaError(`Unknown field [${node.name}]${hint ? `. Did you mean [${hint}]?` : ''}`, node.start, node.end);
  }
  if (matches.length > 1)
    throw new FormulaError(
      `[${node.name}] exists in more than one table. Write ${matches.map((m) => `[${m.table.name}].[${m.name}]`).join(' or ')}`,
      node.start,
      node.end
    );
  const m = matches[0];
  return { t: 'col', table: m.table.id, column: m.name, dataType: m.type, vtype: dataTypeToVType(m.type), level: 'row', start: node.start, end: node.end };
}

function combineLevels(nodes: TNode[], span: Span): Level {
  let level: Level = 'const';
  for (const n of nodes) {
    level = combine2(level, n, span);
  }
  return level;
}

function combine2(a: Level, n: TNode, span: Span): Level {
  const b = n.level;
  if (a === 'const') return b;
  if (b === 'const' || a === b) return a;
  const pair = new Set([a, b]);
  if (pair.has('agg') && pair.has('tcalc')) return 'tcalc';
  if (pair.has('row') && (pair.has('agg') || pair.has('tcalc')))
    throw new FormulaError(
      'Cannot mix aggregate and row-level values. Wrap the row-level field in an aggregate such as SUM or MIN',
      span.start,
      span.end
    );
  if (pair.has('lod'))
    throw new FormulaError(
      'INCLUDE and EXCLUDE expressions can only be combined with constants or other INCLUDE/EXCLUDE expressions, then aggregated as a whole, for example AVG({INCLUDE [Customer] : SUM([Sales])})',
      span.start,
      span.end
    );
  throw new FormulaError('These values cannot be combined', span.start, span.end);
}

function isTemporal(t: VType): boolean {
  return t === 'date' || t === 'datetime';
}

function compatible(a: VType, b: VType): boolean {
  if (a === 'null' || b === 'null' || a === b) return true;
  return isTemporal(a) && isTemporal(b);
}

function unify(types: VType[], span: Span, what: string): VType {
  let out: VType = 'null';
  for (const t of types) {
    if (!compatible(out, t))
      throw new FormulaError(`All ${what} must have the same type, but found ${out} and ${t}`, span.start, span.end);
    if (out === 'null' || (out === 'date' && t === 'datetime')) out = t;
  }
  return out;
}

function expectType(n: TNode, allowed: VType[], fn: string, argIndex: number): void {
  if (n.vtype === 'null' || allowed.includes(n.vtype)) return;
  throw new FormulaError(
    `Argument ${argIndex + 1} of ${fn} must be ${allowed.join(' or ')}, but it is ${n.vtype}`,
    n.start,
    n.end
  );
}

function check(node: Node, env: Env): TNode {
  switch (node.type) {
    case 'num':
      return { t: 'lit', value: node.value, vtype: 'number', level: 'const', start: node.start, end: node.end };
    case 'str':
      return { t: 'lit', value: node.value, vtype: 'string', level: 'const', start: node.start, end: node.end };
    case 'bool':
      return { t: 'lit', value: node.value, vtype: 'boolean', level: 'const', start: node.start, end: node.end };
    case 'null':
      return { t: 'lit', value: null, vtype: 'null', level: 'const', start: node.start, end: node.end };
    case 'date':
      return { t: 'lit', value: node.value, vtype: node.datetime ? 'datetime' : 'date', level: 'const', start: node.start, end: node.end };
    case 'field':
      return resolveField(node, env);
    case 'unary': {
      const arg = check(node.arg, env);
      if (node.op === '-') {
        expectType(arg, ['number'], 'minus', 0);
        return { t: 'unary', op: '-', arg, vtype: 'number', level: arg.level, start: node.start, end: node.end };
      }
      expectType(arg, ['boolean'], 'NOT', 0);
      return { t: 'unary', op: 'NOT', arg, vtype: 'boolean', level: arg.level, start: node.start, end: node.end };
    }
    case 'binary': {
      const left = check(node.left, env);
      const right = check(node.right, env);
      const level = combineLevels([left, right], node);
      let vtype: VType;
      switch (node.op) {
        case '+':
          if ((left.vtype === 'string' || left.vtype === 'null') && (right.vtype === 'string' || right.vtype === 'null') && (left.vtype === 'string' || right.vtype === 'string'))
            vtype = 'string';
          else {
            numericOperands(left, right, '+');
            vtype = 'number';
          }
          break;
        case '-':
        case '*':
        case '/':
          numericOperands(left, right, node.op);
          vtype = 'number';
          break;
        case 'AND':
        case 'OR':
          expectType(left, ['boolean'], node.op, 0);
          expectType(right, ['boolean'], node.op, 1);
          vtype = 'boolean';
          break;
        default:
          if (!compatible(left.vtype, right.vtype))
            throw new FormulaError(`Cannot compare ${left.vtype} with ${right.vtype}`, node.start, node.end);
          vtype = 'boolean';
      }
      return { t: 'binary', op: node.op, left, right, vtype, level, start: node.start, end: node.end };
    }
    case 'if': {
      const branches = node.branches.map((b) => ({ cond: check(b.cond, env), then: check(b.then, env) }));
      for (const b of branches) expectType(b.cond, ['boolean'], 'IF condition', 0);
      const elseNode = node.else ? check(node.else, env) : undefined;
      const all = [...branches.flatMap((b) => [b.cond, b.then]), ...(elseNode ? [elseNode] : [])];
      const level = combineLevels(all, node);
      const vtype = unify([...branches.map((b) => b.then.vtype), ...(elseNode ? [elseNode.vtype] : [])], node, 'IF results');
      return { t: 'if', branches, else: elseNode, vtype, level, start: node.start, end: node.end };
    }
    case 'case': {
      const subject = check(node.subject, env);
      const whens = node.whens.map((w) => ({ match: check(w.match, env), then: check(w.then, env) }));
      for (const w of whens)
        if (!compatible(subject.vtype, w.match.vtype))
          throw new FormulaError(`WHEN value is ${w.match.vtype} but CASE compares ${subject.vtype}`, w.match.start, w.match.end);
      const elseNode = node.else ? check(node.else, env) : undefined;
      const level = combineLevels([subject, ...whens.flatMap((w) => [w.match, w.then]), ...(elseNode ? [elseNode] : [])], node);
      const vtype = unify([...whens.map((w) => w.then.vtype), ...(elseNode ? [elseNode.vtype] : [])], node, 'CASE results');
      return { t: 'case', subject, whens, else: elseNode, vtype, level, start: node.start, end: node.end };
    }
    case 'lod':
      return checkLod(node, env);
    case 'call':
      return checkCall(node, env);
  }
}

function numericOperands(left: TNode, right: TNode, op: string): void {
  for (const [i, n] of [left, right].entries())
    if (n.vtype !== 'number' && n.vtype !== 'null')
      throw new FormulaError(
        `${op} needs numbers, but the ${i === 0 ? 'left' : 'right'} side is ${n.vtype}${n.vtype.startsWith('date') && op !== '*' && op !== '/' ? '. Use DATEADD or DATEDIFF for dates' : ''}`,
        n.start,
        n.end
      );
}

function containsKind(n: TNode, pred: (n: TNode) => boolean): boolean {
  if (pred(n)) return true;
  switch (n.t) {
    case 'unary':
      return containsKind(n.arg, pred);
    case 'binary':
      return containsKind(n.left, pred) || containsKind(n.right, pred);
    case 'call':
      return n.args.some((a) => containsKind(a, pred));
    case 'if':
      return n.branches.some((b) => containsKind(b.cond, pred) || containsKind(b.then, pred)) || (!!n.else && containsKind(n.else, pred));
    case 'case':
      return containsKind(n.subject, pred) || n.whens.some((w) => containsKind(w.match, pred) || containsKind(w.then, pred)) || (!!n.else && containsKind(n.else, pred));
    case 'lod':
      return n.dims.some((d) => containsKind(d, pred)) || containsKind(n.body, pred);
    default:
      return false;
  }
}

/** True when a column is referenced outside any INCLUDE or EXCLUDE expression. */
function colOutsideLod(n: TNode): boolean {
  if (n.t === 'col') return true;
  if (n.t === 'lod' && n.kind !== 'FIXED') return false;
  switch (n.t) {
    case 'unary':
      return colOutsideLod(n.arg);
    case 'binary':
      return colOutsideLod(n.left) || colOutsideLod(n.right);
    case 'call':
      return n.args.some(colOutsideLod);
    case 'if':
      return n.branches.some((b) => colOutsideLod(b.cond) || colOutsideLod(b.then)) || (!!n.else && colOutsideLod(n.else));
    case 'case':
      return colOutsideLod(n.subject) || n.whens.some((w) => colOutsideLod(w.match) || colOutsideLod(w.then)) || (!!n.else && colOutsideLod(n.else));
    case 'lod':
      return true;
    default:
      return false;
  }
}

export function walk(n: TNode, visit: (n: TNode) => void): void {
  containsKind(n, (x) => {
    visit(x);
    return false;
  });
}

function checkLod(node: Extract<Node, { type: 'lod' }>, env: Env): TNode {
  const dims = node.dims.map((d) => check(d, env));
  for (const d of dims) {
    if (d.level !== 'row')
      throw new FormulaError(`${node.kind} dimensions must be row-level fields, not ${d.level === 'const' ? 'constants' : 'aggregates'}`, d.start, d.end);
  }
  const body = check(node.body, env);
  if (body.level !== 'agg')
    throw new FormulaError(
      `The part after ':' in a ${node.kind} expression must be an aggregate, for example SUM([Sales])`,
      body.start,
      body.end
    );
  if (containsKind(body, (n) => n.t === 'lod' && n.kind !== 'FIXED'))
    throw new FormulaError('INCLUDE and EXCLUDE cannot be nested inside another level of detail expression', body.start, body.end);
  if (node.kind !== 'FIXED' && containsKind(body, (n) => n.t === 'lod'))
    throw new FormulaError('Level of detail expressions cannot be nested inside INCLUDE or EXCLUDE', body.start, body.end);
  return {
    t: 'lod',
    kind: node.kind,
    dims,
    body,
    vtype: body.vtype,
    level: node.kind === 'FIXED' ? 'row' : 'lod',
    start: node.start,
    end: node.end
  };
}

function arity(node: Extract<Node, { type: 'call' }>, min: number, max = min): void {
  const n = node.args.length;
  if (n < min || n > max) {
    const want = min === max ? `${min}` : `${min} to ${max}`;
    throw new FormulaError(`${node.name} takes ${want} argument${max === 1 ? '' : 's'}, but got ${n}`, node.start, node.end);
  }
}

function datePart(n: TNode, fn: string, datetime: boolean): void {
  if (n.t !== 'lit' || typeof n.value !== 'string')
    throw new FormulaError(`The first argument of ${fn} must be a date part in quotes, such as 'month'`, n.start, n.end);
  const parts: readonly string[] = datetime ? DATE_PARTS : DATE_PARTS.slice(0, 5);
  if (!parts.includes(n.value.toLowerCase()))
    throw new FormulaError(`'${n.value}' is not a date part. Use one of ${parts.map((p) => `'${p}'`).join(', ')}`, n.start, n.end);
}

function checkCall(node: Extract<Node, { type: 'call' }>, env: Env): TNode {
  const name = node.name;
  const args = node.args.map((a) => check(a, env));
  const out = (vtype: VType, level: Level): TNode => ({ t: 'call', name, args, vtype, level, start: node.start, end: node.end });

  if (AGGREGATES.has(name)) {
    arity(node, 1);
    const a = args[0];
    if (a.level === 'agg' || a.level === 'tcalc')
      throw new FormulaError(`${name} cannot be applied to a value that is already aggregated`, a.start, a.end);
    if (containsKind(a, (n) => n.t === 'lod' && n.kind !== 'FIXED')) {
      if (colOutsideLod(a))
        throw new FormulaError(
          `Inside ${name}, an INCLUDE or EXCLUDE expression can only be combined with constants`,
          a.start,
          a.end
        );
    }
    if (name === 'SUM' || name === 'AVG' || name === 'MEDIAN') expectType(a, ['number'], name, 0);
    if (name === 'MIN' || name === 'MAX') expectType(a, ['number', 'string', 'date', 'datetime'], name, 0);
    const vtype: VType = name === 'COUNT' || name === 'COUNTD' ? 'number' : name === 'MIN' || name === 'MAX' ? a.vtype : 'number';
    return out(vtype, 'agg');
  }

  if (TABLE_CALCS.has(name)) {
    if (name === 'LAG') arity(node, 1, 2);
    else arity(node, 1);
    const a = args[0];
    if (a.level !== 'agg')
      throw new FormulaError(
        a.level === 'tcalc'
          ? `${name} cannot be applied to another table calculation`
          : `${name} works on aggregated values. Wrap the field in an aggregate, for example ${name}(SUM([Sales]))`,
        a.start,
        a.end
      );
    if (name !== 'LAG' && name !== 'RANK') expectType(a, ['number'], name, 0);
    if (name === 'LAG' && args[1]) {
      const off = args[1];
      if (off.t !== 'lit' || typeof off.value !== 'number' || !Number.isInteger(off.value) || off.value < 1 || off.value > 1000)
        throw new FormulaError('The LAG offset must be a whole number from 1 to 1000', off.start, off.end);
    }
    const vtype: VType = name === 'LAG' ? a.vtype : 'number';
    return out(vtype, 'tcalc');
  }

  const level = (): Level => combineLevels(args, node);
  switch (name) {
    case 'ISNULL':
      arity(node, 1);
      return out('boolean', level());
    case 'IFNULL':
      arity(node, 2);
      return out(unify([args[0].vtype, args[1].vtype], node, 'IFNULL arguments'), level());
    case 'LEFT':
    case 'RIGHT':
      arity(node, 2);
      expectType(args[0], ['string'], name, 0);
      expectType(args[1], ['number'], name, 1);
      return out('string', level());
    case 'UPPER':
    case 'LOWER':
    case 'TRIM':
      arity(node, 1);
      expectType(args[0], ['string'], name, 0);
      return out('string', level());
    case 'CONTAINS':
      arity(node, 2);
      expectType(args[0], ['string'], name, 0);
      expectType(args[1], ['string'], name, 1);
      return out('boolean', level());
    case 'REPLACE':
      arity(node, 3);
      args.forEach((a, i) => expectType(a, ['string'], name, i));
      return out('string', level());
    case 'YEAR':
    case 'QUARTER':
    case 'MONTH':
    case 'DAY':
      arity(node, 1);
      expectType(args[0], ['date', 'datetime'], name, 0);
      return out('number', level());
    case 'DATETRUNC':
      arity(node, 2);
      expectType(args[1], ['date', 'datetime'], name, 1);
      datePart(args[0], name, args[1].vtype === 'datetime');
      return out(args[1].vtype === 'datetime' ? 'datetime' : 'date', level());
    case 'DATEADD':
      arity(node, 3);
      expectType(args[1], ['number'], name, 1);
      expectType(args[2], ['date', 'datetime'], name, 2);
      datePart(args[0], name, args[2].vtype === 'datetime');
      return out(args[2].vtype === 'datetime' ? 'datetime' : 'date', level());
    case 'DATEDIFF':
      arity(node, 3);
      expectType(args[1], ['date', 'datetime'], name, 1);
      expectType(args[2], ['date', 'datetime'], name, 2);
      datePart(args[0], name, args[1].vtype === 'datetime' || args[2].vtype === 'datetime');
      return out('number', level());
    case 'TODAY':
      arity(node, 0);
      return out('date', 'row');
    case 'ABS':
    case 'FLOOR':
    case 'CEIL':
      arity(node, 1);
      expectType(args[0], ['number'], name, 0);
      return out('number', level());
    case 'ROUND':
      arity(node, 1, 2);
      expectType(args[0], ['number'], name, 0);
      if (args[1]) {
        const d = args[1];
        if (d.t !== 'lit' || typeof d.value !== 'number' || !Number.isInteger(d.value) || d.value < -10 || d.value > 15)
          throw new FormulaError('ROUND decimals must be a whole number from -10 to 15', d.start, d.end);
      }
      return out('number', level());
    default: {
      const hint = suggest(name, ALL_FUNCTIONS);
      throw new FormulaError(`Unknown function ${name}${hint ? `. Did you mean ${hint}?` : ''}`, node.start, node.start + name.length);
    }
  }
}

function suggest(word: string, candidates: string[]): string | undefined {
  const w = word.toLowerCase();
  let best: string | undefined;
  let bestD = Math.max(2, Math.floor(w.length / 3)) + 1;
  for (const c of candidates) {
    const d = levenshtein(w, c.toLowerCase());
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
