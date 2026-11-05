/**
 * VizSpec + Model -> one SQL statement.
 *
 * The statement is a chain of CTEs that applies the query pipeline in this order:
 *  1. Data source filters             (per-table CTEs "s0", "s1", ...)
 *  2. Joins from model relationships  ("base0", only tables the query needs)
 *  3. Context filters                 (WHERE of "base0")
 *  4. FIXED expressions               ("fx0" grouped, joined back as "base1", ...)
 *  5. Dimension filters, slicers and cross-filters ("filtered", then Top N filters "top0", ...)
 *  6. Aggregation at the view's level of detail ("dims", "agg"; INCLUDE/EXCLUDE use "lg"/"lk"/"la")
 *  7. Measure filters                 ("having")
 *  8. Table calculations (window functions), then sort and row limit (final SELECT)
 *
 * Identifiers are always quoted and values are always bound parameters.
 */
import { FormulaError } from '../formula/ast';
import {
  AGGREGATES,
  TABLE_CALCS,
  fieldLabel,
  fieldNode,
  walk,
  type TNode,
  type VType
} from '../formula/check';
import type {
  AggFn,
  DataType,
  DateLevel,
  FieldRef,
  FilterDef,
  Model,
  OutputColumn,
  Relationship,
  Scalar,
  ShelfItem,
  TableDef,
  VizSpec
} from '../types';
import { Params, engineTableName, numberType, quoteIdent as q, sqlType } from './sql';

export class CompileError extends Error {
  constructor(
    message: string,
    public readonly itemId?: string
  ) {
    super(message);
    this.name = 'CompileError';
  }
}

export interface CompileOptions {
  /** Maximum rows returned. The query asks for one more row to detect truncation. Default 10000. */
  maxRows?: number;
  /** Slicers and cross-filters from a dashboard, applied with the dimension filters. */
  externalFilters?: FilterDef[];
  /** Skip the row limit (used for CSV export). */
  noLimit?: boolean;
}

export interface CompiledQuery {
  sql: string;
  params: Scalar[];
  columns: OutputColumn[];
  warnings: string[];
  maxRows: number;
}

export const DEFAULT_MAX_ROWS = 10000;

type Stage = 'datasource' | 'context' | 'row';

interface DimInfo {
  item: ShelfItem;
  alias: string;
  baseSql: string;
  sql: string;
}

interface GrainGroup {
  key: string;
  /** Grain column aliases (from the "dims" CTE). */
  grain: string[];
  bodies: { sql: string; alias: string; key: string }[];
  outer: { sql: string; alias: string; key: string }[];
  index: number;
}

interface FixedLod {
  alias: string;
  key: string;
  dims: string[];
  body: string;
}

const ITEM_ORDER = ['columns', 'rows', 'color', 'size', 'label', 'tooltip'] as const;

export function shelfItems(spec: VizSpec): ShelfItem[] {
  return [
    ...spec.columns,
    ...spec.rows,
    ...(spec.color ? [spec.color] : []),
    ...(spec.size ? [spec.size] : []),
    ...(spec.label ? [spec.label] : []),
    ...spec.tooltip
  ];
}

export function defaultAgg(vtype: VType): AggFn {
  return vtype === 'number' ? 'SUM' : 'COUNTD';
}

/** Builds the typed expression for a shelf item used as a measure. */
export function measureNode(field: FieldRef, agg: AggFn | undefined, model: Model): TNode {
  const node = fieldNode(field, model);
  if (node.level === 'agg' || node.level === 'tcalc') return node;
  const fn = agg ?? defaultAgg(node.level === 'lod' ? 'number' : node.vtype);
  if ((fn === 'SUM' || fn === 'AVG' || fn === 'MEDIAN') && node.vtype !== 'number' && node.vtype !== 'null')
    throw new FormulaError(`${fn} needs a number, but ${fieldLabel(field, model)} is ${node.vtype}`, 0, 0);
  const vtype: VType = fn === 'COUNT' || fn === 'COUNTD' ? 'number' : fn === 'MIN' || fn === 'MAX' ? node.vtype : 'number';
  return { t: 'call', name: fn, args: [node], vtype, level: 'agg', start: 0, end: 0 };
}

export function itemLabel(item: ShelfItem, model: Model): string {
  const name = fieldLabel(item.field, model);
  if (item.role === 'dimension') return item.dateLevel ? `${cap(item.dateLevel)} of ${name}` : name;
  if (item.field.kind === 'calc') {
    try {
      const n = fieldNode(item.field, model);
      if (n.level === 'agg' || n.level === 'tcalc') return name;
    } catch {
      return name;
    }
  }
  let agg = item.agg;
  if (!agg) {
    try {
      const n = fieldNode(item.field, model);
      agg = defaultAgg(n.level === 'lod' ? 'number' : n.vtype);
    } catch {
      agg = 'SUM';
    }
  }
  return `${agg === 'COUNTD' ? 'Distinct count' : cap(agg.toLowerCase())} of ${name}`;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function compileViz(spec: VizSpec, model: Model, opts: CompileOptions = {}): CompiledQuery {
  return new Compiler(spec, model, opts).compile();
}

class Compiler {
  private readonly p = new Params();
  private readonly cols = new Map<string, { alias: string; table: string; column: string }>();
  private readonly fixed: FixedLod[] = [];
  private readonly aggs = new Map<string, string>();
  private readonly grains = new Map<string, GrainGroup>();
  private readonly grainCols = new Map<string, string>();
  private readonly warnings: string[] = [];
  private dims: DimInfo[] = [];
  private currentItem?: string;

  constructor(
    private readonly spec: VizSpec,
    private readonly model: Model,
    private readonly opts: CompileOptions
  ) {}

  private fail(message: string): never {
    throw new CompileError(message, this.currentItem);
  }

  private node(fn: () => TNode): TNode {
    try {
      return fn();
    } catch (e) {
      if (e instanceof FormulaError) this.fail(e.message);
      throw e;
    }
  }

  compile(): CompiledQuery {
    const { spec, model } = this;
    const items = shelfItems(spec);
    if (items.length === 0) throw new CompileError('Add a field to a shelf to build a view');

    // Dimensions first, so table calculations and LOD grains know the view's level of detail.
    for (const item of items) {
      if (item.role !== 'dimension') continue;
      this.currentItem = item.id;
      const node = this.node(() => fieldNode(item.field, model));
      if (node.level !== 'row' && node.level !== 'const')
        this.fail(`${fieldLabel(item.field, model)} is an aggregate and cannot be used as a dimension. Place it as a measure`);
      const baseSql = this.rowSql(node, 'row');
      const sql = this.truncate(baseSql, node, item.dateLevel);
      this.dims.push({ item, alias: `d${this.dims.length}`, baseSql, sql });
    }

    // Measures and outputs, in shelf order.
    const outputs: { col: OutputColumn; sql: string }[] = [];
    items.forEach((item, i) => {
      this.currentItem = item.id;
      const alias = `o${i}`;
      const label = itemLabel(item, model);
      if (item.role === 'dimension') {
        const d = this.dims.find((x) => x.item === item) as DimInfo;
        const node = this.node(() => fieldNode(item.field, model));
        outputs.push({ col: { key: item.id, alias, role: 'dimension', type: outType(node, item.dateLevel), label, dateLevel: item.dateLevel }, sql: q(d.alias) });
      } else {
        const node = this.node(() => measureNode(item.field, item.agg, model));
        outputs.push({ col: { key: item.id, alias, role: 'measure', type: outType(node), label }, sql: this.aggSql(node) });
      }
    });
    this.currentItem = undefined;

    // Filters.
    const ctxWhere: string[] = [];
    const dimWhere: string[] = [];
    const measureWhere: string[] = [];
    const topN: { dim: string; by: string; n: number; dir: 'top' | 'bottom' }[] = [];
    for (const f of spec.filters) {
      this.currentItem = f.id;
      if (f.kind === 'measure') {
        if (f.context) this.fail('Measure filters cannot be context filters');
        const node = this.node(() => measureNode(f.field, f.agg, model));
        if (node.level === 'tcalc') this.fail('Filters on table calculations are not supported in this version');
        measureWhere.push(`${this.aggSql(node)} ${f.op === '!=' ? '<>' : f.op} ${this.p.add(f.value, 'DOUBLE')}`);
      } else if (f.kind === 'topN') {
        topN.push(this.topN(f));
      } else {
        const stage: Stage = f.context ? 'context' : 'row';
        (f.context ? ctxWhere : dimWhere).push(this.predicate(f, stage));
      }
    }
    this.currentItem = undefined;

    // Tables the view itself needs decide the join root. Slicers on unrelated tables are skipped.
    const viewTables = new Set([...this.cols.values()].map((c) => c.table));
    if (viewTables.size === 0) throw new CompileError('The view does not use any table fields');
    const root = this.pickRoot(viewTables);
    const reach = this.reachable(root);
    for (const t of viewTables)
      if (!reach.has(t))
        throw new CompileError(
          `${this.tableName(t)} is not related to ${this.tableName(root)}. Add a relationship in the Model view`
        );
    for (const f of this.opts.externalFilters ?? []) {
      if (f.kind === 'measure' || f.kind === 'topN') continue;
      const tables = this.filterTables(f);
      if (tables === null) continue;
      const missing = [...tables].filter((t) => !reach.has(t));
      if (missing.length > 0) {
        this.warnings.push(
          `A filter on ${fieldLabel(f.field, model)} does not apply here because ${this.tableName(missing[0])} is not related to ${this.tableName(root)}`
        );
        continue;
      }
      dimWhere.push(this.predicate(f, 'row'));
    }

    // INCLUDE/EXCLUDE grains reference dimension aliases, so they are resolved after all dims.
    return this.assemble(root, outputs, ctxWhere, dimWhere, measureWhere, topN);
  }

  // ---------------------------------------------------------------- tables and joins

  private tableName(id: string): string {
    return this.model.tables.find((t) => t.id === id)?.name ?? id;
  }

  private table(id: string): TableDef {
    const t = this.model.tables.find((x) => x.id === id);
    if (!t) this.fail(`Table ${id} is missing from the model`);
    return t;
  }

  private pickRoot(tables: Set<string>): string {
    // The largest table is usually the fact table, so dimension tables join many-to-one onto it.
    let best = '';
    let bestRows = -1;
    for (const t of this.model.tables) {
      if (!tables.has(t.id)) continue;
      if (t.rowCount > bestRows) {
        best = t.id;
        bestRows = t.rowCount;
      }
    }
    return best;
  }

  private reachable(root: string): Map<string, { parent: string; rel: Relationship } | null> {
    const seen = new Map<string, { parent: string; rel: Relationship } | null>([[root, null]]);
    const queue = [root];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const rel of this.model.relationships) {
        const other = rel.fromTable === cur ? rel.toTable : rel.toTable === cur ? rel.fromTable : null;
        if (other === null || seen.has(other)) continue;
        if (!this.model.tables.some((t) => t.id === other)) continue;
        seen.set(other, { parent: cur, rel });
        queue.push(other);
      }
    }
    return seen;
  }

  private filterTables(f: FilterDef): Set<string> | null {
    try {
      const node = fieldNode(f.field, this.model);
      const out = new Set<string>();
      walk(node, (n) => {
        if (n.t === 'col') out.add(n.table);
      });
      return out;
    } catch {
      return null;
    }
  }

  private col(table: string, column: string): string {
    const key = `${table}\u0000${column}`;
    let c = this.cols.get(key);
    if (!c) {
      c = { alias: `c${this.cols.size}`, table, column };
      this.cols.set(key, c);
    }
    return q(c.alias);
  }

  // ---------------------------------------------------------------- expressions

  private truncate(sql: string, node: TNode, level: DateLevel | undefined): string {
    if (!level) return sql;
    if (node.vtype !== 'date' && node.vtype !== 'datetime') return sql;
    return `CAST(date_trunc(${this.p.add(level, 'VARCHAR')}, ${sql}) AS DATE)`;
  }

  private lit(value: Scalar, vtype: VType): string {
    if (value === null) return 'NULL';
    switch (vtype) {
      case 'number':
        return this.p.add(value, numberType(value as number));
      case 'string':
        return this.p.add(value, 'VARCHAR');
      case 'boolean':
        return this.p.add(value, 'BOOLEAN');
      case 'date':
        return this.p.add(value, 'DATE');
      case 'datetime':
        return this.p.add(value, 'TIMESTAMP');
      default:
        return 'NULL';
    }
  }

  /** Shared emission for operators and row-level functions; `sub` compiles children. */
  private emit(n: TNode, sub: (n: TNode) => string): string {
    switch (n.t) {
      case 'lit':
        return this.lit(n.value, n.vtype);
      case 'unary':
        return n.op === '-' ? `(-${sub(n.arg)})` : `(NOT ${sub(n.arg)})`;
      case 'binary': {
        const l = sub(n.left);
        const r = sub(n.right);
        switch (n.op) {
          case '+':
            return n.vtype === 'string' ? `(${l} || ${r})` : `(${l} + ${r})`;
          case '/':
            // Safe division: null when the divisor is zero.
            return `(CAST(${l} AS DOUBLE) / NULLIF(CAST(${r} AS DOUBLE), 0))`;
          case '!=':
            return `(${l} <> ${r})`;
          default:
            return `(${l} ${n.op} ${r})`;
        }
      }
      case 'if': {
        const parts = n.branches.map((b) => `WHEN ${sub(b.cond)} THEN ${sub(b.then)}`);
        return `(CASE ${parts.join(' ')}${n.else ? ` ELSE ${sub(n.else)}` : ''} END)`;
      }
      case 'case': {
        const parts = n.whens.map((w) => `WHEN ${sub(w.match)} THEN ${sub(w.then)}`);
        return `(CASE ${sub(n.subject)} ${parts.join(' ')}${n.else ? ` ELSE ${sub(n.else)}` : ''} END)`;
      }
      case 'call':
        return this.rowFunc(n, sub);
      default:
        return this.fail('Unexpected expression');
    }
  }

  private rowFunc(n: Extract<TNode, { t: 'call' }>, sub: (n: TNode) => string): string {
    const a = n.args;
    const part = (i: number): string => String((a[i] as Extract<TNode, { t: 'lit' }>).value).toLowerCase();
    switch (n.name) {
      case 'ISNULL':
        return `(${sub(a[0])} IS NULL)`;
      case 'IFNULL':
        return `COALESCE(${sub(a[0])}, ${sub(a[1])})`;
      case 'LEFT':
        return `left(${sub(a[0])}, CAST(${sub(a[1])} AS BIGINT))`;
      case 'RIGHT':
        return `right(${sub(a[0])}, CAST(${sub(a[1])} AS BIGINT))`;
      case 'UPPER':
        return `upper(${sub(a[0])})`;
      case 'LOWER':
        return `lower(${sub(a[0])})`;
      case 'TRIM':
        return `trim(${sub(a[0])})`;
      case 'CONTAINS':
        return `contains(${sub(a[0])}, ${sub(a[1])})`;
      case 'REPLACE':
        return `replace(${sub(a[0])}, ${sub(a[1])}, ${sub(a[2])})`;
      case 'YEAR':
        return `year(${sub(a[0])})`;
      case 'QUARTER':
        return `quarter(${sub(a[0])})`;
      case 'MONTH':
        return `month(${sub(a[0])})`;
      case 'DAY':
        return `day(${sub(a[0])})`;
      case 'DATETRUNC': {
        const t = n.vtype === 'datetime' ? 'TIMESTAMP' : 'DATE';
        return `CAST(date_trunc(${this.p.add(part(0), 'VARCHAR')}, ${sub(a[1])}) AS ${t})`;
      }
      case 'DATEADD': {
        const unit = part(0);
        const amount = `CAST(${sub(a[1])} AS INTEGER)`;
        const interval =
          unit === 'quarter' ? `to_months(3 * ${amount})` : `${INTERVAL_FN[unit as keyof typeof INTERVAL_FN]}(${amount})`;
        const t = n.vtype === 'datetime' ? 'TIMESTAMP' : 'DATE';
        return `CAST(${sub(a[2])} + ${interval} AS ${t})`;
      }
      case 'DATEDIFF':
        return `date_diff(${this.p.add(part(0), 'VARCHAR')}, ${sub(a[1])}, ${sub(a[2])})`;
      case 'TODAY':
        return 'current_date';
      case 'ABS':
        return `abs(${sub(a[0])})`;
      case 'FLOOR':
        return `floor(${sub(a[0])})`;
      case 'CEIL':
        return `ceil(${sub(a[0])})`;
      case 'ROUND':
        return a[1] ? `round(${sub(a[0])}, ${sub(a[1])})` : `round(${sub(a[0])})`;
      default:
        return this.fail(`${n.name} cannot be used here`);
    }
  }

  /** Row-level SQL over the joined base rows. */
  private rowSql(n: TNode, stage: Stage): string {
    if (n.t === 'col') return this.col(n.table, n.column);
    if (n.t === 'lod') {
      if (n.kind !== 'FIXED') this.fail('INCLUDE and EXCLUDE expressions must be aggregated, for example AVG({INCLUDE ...})');
      if (stage === 'context') this.fail('Context filters run before FIXED expressions, so they cannot use one');
      return this.fixedLod(n, stage);
    }
    if (n.t === 'call' && (AGGREGATES.has(n.name) || TABLE_CALCS.has(n.name)))
      this.fail('An aggregate cannot be used where a row-level value is needed');
    return this.emit(n, (c) => this.rowSql(c, stage));
  }

  /** Aggregate SQL computed inline (FIXED bodies, LOD bodies, Top N ranking). */
  private inlineAgg(n: TNode, stage: Stage): string {
    if (n.t === 'call' && AGGREGATES.has(n.name)) return aggCall(n.name, this.rowSql(n.args[0], stage));
    if (n.t === 'call' && TABLE_CALCS.has(n.name)) this.fail('Table calculations cannot be used inside this expression');
    if (n.level === 'row') this.fail('A row-level value cannot be used here without an aggregate');
    return this.emit(n, (c) => this.inlineAgg(c, stage));
  }

  private fixedLod(n: Extract<TNode, { t: 'lod' }>, stage: Stage): string {
    const dims = n.dims.map((d) => this.rowSql(d, stage));
    const body = this.inlineAgg(n.body, stage);
    // Dedupe on structure (param placeholders differ between compilations, so strip them).
    const key = structuralKey(n);
    const existing = this.fixed.find((f) => f.key === key);
    if (existing) return q(existing.alias);
    const f: FixedLod = { alias: `x${this.fixed.length}`, key, dims, body };
    this.fixed.push(f);
    return q(f.alias);
  }

  /** SQL for an aggregate-level expression in the final SELECT, over the "having" CTE. */
  private aggSql(n: TNode): string {
    if (n.t === 'call' && AGGREGATES.has(n.name)) {
      const arg = n.args[0];
      if (containsLod(arg)) return q(this.lodAggregate(n.name, arg));
      const sql = aggCall(n.name, this.rowSql(arg, 'row'));
      let alias = this.aggs.get(sql);
      if (!alias) {
        alias = `a${this.aggs.size + this.grainOuterCount()}`;
        this.aggs.set(sql, alias);
      }
      return q(alias);
    }
    if (n.t === 'call' && TABLE_CALCS.has(n.name)) return this.tableCalc(n);
    if (n.level === 'row' || n.level === 'lod') this.fail('Wrap row-level fields in an aggregate such as SUM');
    return this.emit(n, (c) => this.aggSql(c));
  }

  private grainOuterCount(): number {
    let n = 0;
    for (const g of this.grains.values()) n += g.outer.length;
    return n;
  }

  /** An aggregate over INCLUDE/EXCLUDE expressions: computed at the LOD grain, then aggregated to the view. */
  private lodAggregate(fn: string, arg: TNode): string {
    const lods: Extract<TNode, { t: 'lod' }>[] = [];
    walk(arg, (x) => {
      if (x.t === 'lod' && x.kind !== 'FIXED') lods.push(x);
    });
    const grain = this.grainFor(lods[0]);
    for (const l of lods.slice(1))
      if (this.grainFor(l).join(',') !== grain.join(','))
        this.fail('One aggregate cannot combine INCLUDE/EXCLUDE expressions with different dimensions');
    const gkey = grain.join(',');
    let group = this.grains.get(gkey);
    if (!group) {
      group = { key: gkey, grain, bodies: [], outer: [], index: this.grains.size };
      this.grains.set(gkey, group);
    }
    const g = group;
    const sub = (x: TNode): string => {
      if (x.t === 'lod' && x.kind !== 'FIXED') {
        const body = this.inlineAgg(x.body, 'row');
        const bkey = structuralKey(x.body);
        let b = g.bodies.find((bb) => bb.key === bkey);
        if (!b) {
          b = { sql: body, alias: `v${g.index}_${g.bodies.length}`, key: bkey };
          g.bodies.push(b);
        }
        return q(b.alias);
      }
      if (x.t === 'col') this.fail('Inside an aggregate, INCLUDE/EXCLUDE expressions can only be combined with constants');
      return this.emit(x, sub);
    };
    const sql = aggCall(fn, sub(arg));
    const okey = `${fn}:${structuralKey(arg)}`;
    let o = g.outer.find((oo) => oo.key === okey);
    if (!o) {
      o = { sql, alias: `a${this.aggs.size + this.grainOuterCount()}`, key: okey };
      g.outer.push(o);
    }
    return o.alias;
  }

  /** Grain column aliases for an INCLUDE/EXCLUDE expression, in the "dims" CTE. */
  private grainFor(l: Extract<TNode, { t: 'lod' }>): string[] {
    const lodDims = l.dims.map((d) => this.rowSql(d, 'row'));
    const viz = this.dims.map((d) => d.alias);
    if (l.kind === 'INCLUDE') {
      const extra: string[] = [];
      for (const sql of lodDims) {
        const same = this.dims.find((d) => d.sql === sql || (d.baseSql === sql && !d.item.dateLevel));
        if (same) continue;
        extra.push(this.grainCol(sql, l.dims[lodDims.indexOf(sql)]));
      }
      return [...new Set([...viz, ...extra])];
    }
    // EXCLUDE removes the matching view dimensions (matched on the field, whatever its date level).
    const keyOf = (n: TNode): string => structuralKey(n);
    const excluded = new Set(l.dims.map(keyOf));
    return this.dims
      .filter((d) => {
        const node = fieldNode(d.item.field, this.model);
        return !excluded.has(keyOf(node));
      })
      .map((d) => d.alias);
  }

  private grainCol(sql: string, node: TNode): string {
    const key = structuralKey(node);
    let alias = this.grainCols.get(key);
    if (!alias) {
      alias = `g${this.grainCols.size}`;
      this.grainCols.set(key, alias);
      this.grainSql.set(alias, sql);
    }
    return alias;
  }
  private readonly grainSql = new Map<string, string>();

  private addressing(): { partition: string[]; order: string[] } {
    if (this.dims.length === 0) return { partition: [], order: [] };
    const rank = (d: DimInfo): number => {
      const s = this.spec;
      if (s.columns.includes(d.item)) return 0;
      if (s.rows.includes(d.item)) return 1;
      if (s.color === d.item) return 2;
      return 3 + ITEM_ORDER.length;
    };
    const sorted = [...this.dims].sort((a, b) => rank(a) - rank(b));
    const address = sorted[0];
    return {
      order: [q(address.alias)],
      partition: this.dims.filter((d) => d !== address).map((d) => q(d.alias))
    };
  }

  private tableCalc(n: Extract<TNode, { t: 'call' }>): string {
    const x = this.aggSql(n.args[0]);
    const { partition, order } = this.addressing();
    const part = partition.length ? `PARTITION BY ${[...new Set(partition)].join(', ')}` : '';
    const ord = order.length ? `ORDER BY ${order.map((o) => `${o} ASC NULLS LAST`).join(', ')}` : '';
    switch (n.name) {
      case 'RUNNING_SUM':
        return `SUM(${x}) OVER (${part} ${ord} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
      case 'PERCENT_OF_TOTAL':
        return `(CAST(${x} AS DOUBLE) / NULLIF(SUM(${x}) OVER (${part}), 0))`;
      case 'RANK':
        return `RANK() OVER (${part} ORDER BY ${x} DESC NULLS LAST)`;
      case 'LAG': {
        const off = n.args[1] && n.args[1].t === 'lit' ? (n.args[1].value as number) : 1;
        return `LAG(${x}, ${this.p.add(off, 'INTEGER')}) OVER (${part} ${ord})`;
      }
      default:
        return this.fail(`Unknown table calculation ${n.name}`);
    }
  }

  // ---------------------------------------------------------------- filters

  private predicate(f: Exclude<FilterDef, { kind: 'measure' | 'topN' }>, stage: Stage): string {
    const node = this.node(() => fieldNode(f.field, this.model));
    if (node.level !== 'row') this.fail(`${fieldLabel(f.field, this.model)} is an aggregate. Use a measure filter`);
    const expr = this.truncate(this.rowSql(node, stage), node, f.dateLevel);
    const t = f.dateLevel && (node.vtype === 'date' || node.vtype === 'datetime') ? 'DATE' : vtypeSql(node);
    return buildPredicate(f, expr, t, this.p);
  }

  private topN(f: Extract<FilterDef, { kind: 'topN' }>): { dim: string; by: string; n: number; dir: 'top' | 'bottom' } {
    if (!Number.isInteger(f.n) || f.n < 1) this.fail('Top N needs a whole number of at least 1');
    const node = this.node(() => fieldNode(f.field, this.model));
    if (node.level !== 'row') this.fail('Top N filters work on dimensions');
    const dim = this.truncate(this.rowSql(node, 'row'), node, f.dateLevel);
    const by = this.node(() => measureNode(f.by.field, f.by.agg, this.model));
    if (by.level !== 'agg' || containsLod(by)) this.fail('Top N can rank by a simple aggregate only');
    return { dim, by: this.inlineAgg(by, 'row'), n: f.n, dir: f.direction };
  }

  // ---------------------------------------------------------------- assembly

  private assemble(
    root: string,
    outputs: { col: OutputColumn; sql: string }[],
    ctxWhere: string[],
    dimWhere: string[],
    measureWhere: string[],
    topN: { dim: string; by: string; n: number; dir: 'top' | 'bottom' }[]
  ): CompiledQuery {
    const ctes: string[] = [];
    const needed = new Set([...this.cols.values()].map((c) => c.table));
    const reach = this.reachable(root);

    // Join tree: the path from the root to every needed table.
    const joinOrder: string[] = [root];
    const edges = new Map<string, { parent: string; rel: Relationship }>();
    for (const t of needed) {
      let cur = t;
      const path: string[] = [];
      while (cur !== root) {
        const step = reach.get(cur);
        if (!step) this.fail(`${this.tableName(t)} is not related to ${this.tableName(root)}`);
        path.unshift(cur);
        edges.set(cur, step);
        cur = step.parent;
      }
      for (const x of path) if (!joinOrder.includes(x)) joinOrder.push(x);
    }

    // Columns each table CTE must expose: used columns plus join keys.
    const tableCols = new Map<string, Set<string>>(joinOrder.map((t) => [t, new Set<string>()]));
    for (const c of this.cols.values()) tableCols.get(c.table)?.add(c.column);
    for (const [child, { parent, rel }] of edges) {
      const [pc, cc] = rel.fromTable === parent ? [rel.fromColumn, rel.toColumn] : [rel.toColumn, rel.fromColumn];
      tableCols.get(parent)?.add(pc);
      tableCols.get(child)?.add(cc);
    }

    // 1. Data source filters, with type overrides applied.
    const sAlias = new Map<string, string>();
    joinOrder.forEach((tid, i) => {
      const table = this.table(tid);
      const alias = `s${i}`;
      sAlias.set(tid, alias);
      const need = tableCols.get(tid) as Set<string>;
      const list = table.columns.filter((c) => need.has(c.name));
      for (const name of need)
        if (!table.columns.some((c) => c.name === name))
          this.fail(`${this.tableName(tid)} has no column ${name}. Reload the table or fix the relationship`);
      const select = list.length
        ? list.map((c) => (c.override && c.override !== c.type ? `TRY_CAST(${q(c.name)} AS ${sqlType(c.override)}) AS ${q(c.name)}` : q(c.name))).join(', ')
        : '1 AS "__none"';
      const filters = (table.filters ?? []).filter((f) => f.kind === 'values' || f.kind === 'range');
      let where = '';
      if (filters.length) {
        where = ` WHERE ${filters
          .map((f) => {
            if (f.field.kind !== 'column' || f.field.table !== tid) this.fail('Data source filters must use a column of their table');
            const col = table.columns.find((c) => c.name === (f.field as { column: string }).column);
            if (!col) this.fail(`Data source filter column ${(f.field as { column: string }).column} is missing`);
            const t = col.override ?? col.type;
            const ff = f as Exclude<FilterDef, { kind: 'measure' | 'topN' }>;
            const expr = ff.dateLevel ? `CAST(date_trunc(${this.p.add(ff.dateLevel, 'VARCHAR')}, ${q(col.name)}) AS DATE)` : q(col.name);
            return buildPredicate(ff, expr, ff.dateLevel ? 'DATE' : sqlType(t), this.p);
          })
          .join(' AND ')}`;
      }
      ctes.push(`${q(alias)} AS (SELECT * FROM (SELECT ${select} FROM ${q(engineTableName(tid))})${where})`);
    });

    // 2. Joins, and 3. context filters.
    const selectCols = [...this.cols.values()].map((c) => `${q(sAlias.get(c.table) as string)}.${q(c.column)} AS ${q(c.alias)}`);
    let from = q(sAlias.get(root) as string);
    for (const tid of joinOrder.slice(1)) {
      const { parent, rel } = edges.get(tid) as { parent: string; rel: Relationship };
      const [pc, cc] = rel.fromTable === parent ? [rel.fromColumn, rel.toColumn] : [rel.toColumn, rel.fromColumn];
      from += ` LEFT JOIN ${q(sAlias.get(tid) as string)} ON ${q(sAlias.get(parent) as string)}.${q(pc)} = ${q(sAlias.get(tid) as string)}.${q(cc)}`;
      this.joinWarning(parent, tid, rel);
    }
    ctes.push(`"base0" AS (SELECT ${selectCols.join(', ')} FROM ${from}${ctxWhere.length ? ` WHERE ${ctxWhere.join(' AND ')}` : ''})`);

    // 4. FIXED expressions, each grouped on its own dimensions and joined back to every row.
    let base = 'base0';
    this.fixed.forEach((f, i) => {
      const keys = f.dims.map((d, j) => `${d} AS ${q(`__k${j}`)}`);
      const group = f.dims.length ? ` GROUP BY ${f.dims.map((_, j) => j + 1).join(', ')}` : '';
      ctes.push(`${q(`fx${i}`)} AS (SELECT ${[...keys, `${f.body} AS "__v"`].join(', ')} FROM ${q(base)}${group})`);
      const on = f.dims.map((d, j) => `${d} IS NOT DISTINCT FROM ${q(`fx${i}`)}.${q(`__k${j}`)}`).join(' AND ');
      const next = `base${i + 1}`;
      ctes.push(
        `${q(next)} AS (SELECT "b".*, ${q(`fx${i}`)}."__v" AS ${q(f.alias)} FROM ${q(base)} AS "b" ${on ? `LEFT JOIN ${q(`fx${i}`)} ON ${on}` : `CROSS JOIN ${q(`fx${i}`)}`})`
      );
      base = next;
    });

    // 5. Dimension filters, slicers and cross-filters, then Top N filters.
    let rows = base;
    if (dimWhere.length) {
      ctes.push(`"filtered" AS (SELECT * FROM ${q(rows)} WHERE ${dimWhere.join(' AND ')})`);
      rows = 'filtered';
    }
    topN.forEach((t, i) => {
      const dir = t.dir === 'top' ? 'DESC' : 'ASC';
      const name = `top${i}`;
      ctes.push(
        `${q(name)} AS (SELECT * FROM ${q(rows)} WHERE ${t.dim} IN (SELECT ${t.dim} FROM ${q(rows)} GROUP BY 1 ORDER BY ${t.by} ${dir} NULLS LAST, 1 ASC LIMIT ${this.p.add(t.n, 'BIGINT')}))`
      );
      rows = name;
    });

    // 6. Aggregation at the view's level of detail.
    const dimCols = this.dims.map((d) => `${d.sql} AS ${q(d.alias)}`);
    const gCols = [...this.grainSql.entries()].map(([alias, sql]) => `${sql} AS ${q(alias)}`);
    ctes.push(`"dims" AS (SELECT *${[...dimCols, ...gCols].map((c) => `, ${c}`).join('')} FROM ${q(rows)})`);
    const V = this.dims.map((d) => q(d.alias));
    const uniqV = [...new Set(V)];
    const groupBy = uniqV.length ? ` GROUP BY ${uniqV.join(', ')}` : '';
    const aggCols = [...this.aggs.entries()].map(([sql, alias]) => `${sql} AS ${q(alias)}`);
    const aggSelect = [...uniqV, ...aggCols];
    if (aggSelect.length === 0) aggSelect.push('COUNT(*) AS "__rows"');
    ctes.push(`"agg" AS (SELECT ${aggSelect.join(', ')} FROM "dims"${groupBy})`);

    // INCLUDE / EXCLUDE: aggregate at the LOD grain, then aggregate again to the view.
    const laJoins: string[] = [];
    const laCols: string[] = [];
    for (const g of this.grains.values()) {
      const i = g.index;
      const grain = g.grain.map(q);
      ctes.push(
        `${q(`lg${i}`)} AS (SELECT ${[...grain, ...g.bodies.map((b) => `${b.sql} AS ${q(b.alias)}`)].join(', ')} FROM "dims"${grain.length ? ` GROUP BY ${grain.join(', ')}` : ''})`
      );
      const union = [...new Set([...uniqV, ...grain])];
      let lk = `lg${i}`;
      if (union.length !== grain.length) {
        const on = grain.map((c) => `"k".${c} IS NOT DISTINCT FROM ${q(`lg${i}`)}.${c}`).join(' AND ');
        ctes.push(
          `${q(`lk${i}`)} AS (SELECT "k".*, ${g.bodies.map((b) => `${q(`lg${i}`)}.${q(b.alias)}`).join(', ')} FROM (SELECT DISTINCT ${union.join(', ')} FROM "dims") AS "k" ${on ? `LEFT JOIN ${q(`lg${i}`)} ON ${on}` : `CROSS JOIN ${q(`lg${i}`)}`})`
        );
        lk = `lk${i}`;
      }
      ctes.push(
        `${q(`la${i}`)} AS (SELECT ${[...uniqV, ...g.outer.map((o) => `${o.sql} AS ${q(o.alias)}`)].join(', ')} FROM ${q(lk)}${groupBy})`
      );
      const on = uniqV.map((c) => `"agg".${c} IS NOT DISTINCT FROM ${q(`la${i}`)}.${c}`).join(' AND ');
      laJoins.push(on ? `LEFT JOIN ${q(`la${i}`)} ON ${on}` : `CROSS JOIN ${q(`la${i}`)}`);
      for (const o of g.outer) laCols.push(`${q(`la${i}`)}.${q(o.alias)}`);
    }
    let aggName = 'agg';
    if (laJoins.length) {
      ctes.push(`"agg2" AS (SELECT ${['"agg".*', ...laCols].join(', ')} FROM "agg" ${laJoins.join(' ')})`);
      aggName = 'agg2';
    }

    // 7. Measure filters.
    if (measureWhere.length) {
      ctes.push(`"having" AS (SELECT * FROM ${q(aggName)} WHERE ${measureWhere.join(' AND ')})`);
      aggName = 'having';
    }

    // 8. Table calculations, sort and row limit.
    const select = outputs.map((o) => `${o.sql} AS ${q(o.col.alias)}`).join(', ');
    const order: string[] = [];
    const sort = this.spec.sort;
    if (sort) {
      const out = outputs.find((o) => o.col.key === sort.itemId);
      if (out) order.push(`${q(out.col.alias)} ${sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`);
    }
    for (const o of outputs) if (o.col.role === 'dimension') order.push(`${q(o.col.alias)} ASC NULLS LAST`);
    const maxRows = this.opts.maxRows ?? DEFAULT_MAX_ROWS;
    const limit = this.opts.noLimit ? '' : ` LIMIT ${this.p.add(maxRows + 1, 'BIGINT')}`;
    const sql = `WITH ${ctes.join(',\n')}\nSELECT ${select} FROM ${q(aggName)}${order.length ? ` ORDER BY ${[...new Set(order)].join(', ')}` : ''}${limit}`;
    return { sql, params: this.p.values, columns: outputs.map((o) => o.col), warnings: this.warnings, maxRows };
  }

  private joinWarning(parent: string, child: string, rel: Relationship): void {
    const card = rel.fromTable === parent ? rel.cardinality : flip(rel.cardinality);
    const a = this.tableName(parent);
    const b = this.tableName(child);
    if (card === 'many-to-many')
      this.warnings.push(
        `${a} and ${b} have a many-to-many relationship. Joining them can multiply rows, so sums and counts may be inflated`
      );
    else if (card === 'one-to-many')
      this.warnings.push(`Each ${a} row can match several ${b} rows, so values from ${a} may be counted more than once`);
  }
}

function flip(c: Relationship['cardinality']): Relationship['cardinality'] {
  if (c === 'one-to-many') return 'many-to-one';
  if (c === 'many-to-one') return 'one-to-many';
  return c;
}

function aggCall(fn: string, arg: string): string {
  switch (fn) {
    case 'COUNTD':
      return `COUNT(DISTINCT ${arg})`;
    case 'MEDIAN':
      return `median(${arg})`;
    default:
      return `${fn}(${arg})`;
  }
}

function containsLod(n: TNode): boolean {
  let found = false;
  walk(n, (x) => {
    if (x.t === 'lod' && x.kind !== 'FIXED') found = true;
  });
  return found;
}

/** A key that identifies an expression's structure, used to dedupe LOD expressions. */
function structuralKey(n: TNode): string {
  return JSON.stringify(n, (k, v) => (k === 'start' || k === 'end' ? undefined : v));
}

function vtypeSql(n: TNode): string {
  if (n.t === 'col') return sqlType(n.dataType);
  switch (n.vtype) {
    case 'number':
      return 'DOUBLE';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMP';
    default:
      return 'VARCHAR';
  }
}

function outType(n: TNode, level?: DateLevel): DataType {
  if (level && (n.vtype === 'date' || n.vtype === 'datetime')) return 'date';
  if (n.t === 'col') return n.dataType;
  if (n.t === 'call' && (n.name === 'COUNT' || n.name === 'COUNTD' || n.name === 'RANK')) return 'integer';
  if (n.vtype === 'null') return 'string';
  return n.vtype;
}

export function buildPredicate(
  f: Exclude<FilterDef, { kind: 'measure' | 'topN' }>,
  expr: string,
  type: string,
  p: Params
): string {
  if (f.kind === 'values') {
    const nonNull = f.values.filter((v) => v !== null);
    const hasNull = nonNull.length !== f.values.length;
    const parts: string[] = [];
    if (nonNull.length) parts.push(`${expr} IN (${nonNull.map((v) => p.add(v, type)).join(', ')})`);
    if (hasNull) parts.push(`${expr} IS NULL`);
    const incl = parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
    return f.exclude ? `(NOT COALESCE(${incl}, FALSE))` : incl;
  }
  const parts: string[] = [];
  if (f.min !== undefined && f.min !== null) parts.push(`${expr} >= ${p.add(f.min, type)}`);
  if (f.max !== undefined && f.max !== null) parts.push(`${expr} <= ${p.add(f.max, type)}`);
  return parts.length ? `(${parts.join(' AND ')})` : 'TRUE';
}

const INTERVAL_FN = {
  year: 'to_years',
  month: 'to_months',
  week: 'to_weeks',
  day: 'to_days',
  hour: 'to_hours',
  minute: 'to_minutes',
  second: 'to_seconds'
} as const;
