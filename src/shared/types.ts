// Core data types shared by the main process and the renderer.
// This folder must stay pure TypeScript: no Electron, Node or DuckDB imports.

export type DataType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime';

export type Scalar = string | number | boolean | null;

export type SourceFormat = 'csv' | 'tsv' | 'parquet' | 'json' | 'excel';

export interface TableSource {
  /** Absolute path at runtime. Stored relative to the project file where possible. */
  path: string;
  format: SourceFormat;
  /** Excel only: sheet name. The first sheet is used when missing. */
  sheet?: string;
}

export interface ColumnDef {
  /** Column name in the source file and in the engine table. */
  name: string;
  /** Type as the engine imported it, for example BIGINT or VARCHAR. */
  sourceType: string;
  /** Type inferred from the source type. */
  type: DataType;
  /** Manual type override chosen by the user. */
  override?: DataType;
}

export interface TableDef {
  /** Stable id. The engine stores the data in a table named after it. */
  id: string;
  /** Display name. */
  name: string;
  source: TableSource;
  columns: ColumnDef[];
  rowCount: number;
  /** Data source filters, applied before anything else. */
  filters?: FilterDef[];
}

/** Cardinality seen from the `from` side: many-to-one means many `from` rows match one `to` row. */
export type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many';

export interface Relationship {
  id: string;
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  cardinality: Cardinality;
}

export interface CalcDef {
  id: string;
  name: string;
  formula: string;
}

export interface Model {
  tables: TableDef[];
  relationships: Relationship[];
  calcs: CalcDef[];
}

export type FieldRef = { kind: 'column'; table: string; column: string } | { kind: 'calc'; id: string };

export const AGG_FNS = ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT', 'COUNTD', 'MEDIAN'] as const;
export type AggFn = (typeof AGG_FNS)[number];

export const DATE_LEVELS = ['year', 'quarter', 'month', 'week', 'day'] as const;
export type DateLevel = (typeof DATE_LEVELS)[number];

export interface NumberFormat {
  style: 'auto' | 'number' | 'percent' | 'currency' | 'compact';
  decimals?: number;
  /** ISO 4217 code for the currency style, for example USD or EUR. */
  currency?: string;
}

export interface ShelfItem {
  id: string;
  field: FieldRef;
  role: 'dimension' | 'measure';
  /** Aggregation applied when a row-level field is used as a measure. */
  agg?: AggFn;
  /** Truncation level for date dimensions. Undefined means the exact value. */
  dateLevel?: DateLevel;
  format?: NumberFormat;
}

export type CompareOp = '>' | '>=' | '<' | '<=' | '=' | '!=';

interface FilterBase {
  id: string;
  field: FieldRef;
  /** Context filters run before FIXED expressions. */
  context?: boolean;
}

export type FilterDef =
  | (FilterBase & { kind: 'values'; dateLevel?: DateLevel; values: Scalar[]; exclude?: boolean })
  | (FilterBase & { kind: 'range'; dateLevel?: DateLevel; min?: Scalar; max?: Scalar })
  | (FilterBase & { kind: 'measure'; agg?: AggFn; op: CompareOp; value: number })
  | (FilterBase & {
      kind: 'topN';
      dateLevel?: DateLevel;
      n: number;
      by: { field: FieldRef; agg?: AggFn };
      direction: 'top' | 'bottom';
    });

export const CHART_TYPES = [
  'bar',
  'stackedBar',
  'line',
  'area',
  'scatter',
  'pie',
  'donut',
  'heatmap',
  'table',
  'pivot',
  'kpi'
] as const;
export type ChartType = (typeof CHART_TYPES)[number];

export interface SortSpec {
  itemId: string;
  dir: 'asc' | 'desc';
}

export interface VizSpec {
  chartType: ChartType | 'auto';
  columns: ShelfItem[];
  rows: ShelfItem[];
  color?: ShelfItem;
  size?: ShelfItem;
  label?: ShelfItem;
  tooltip: ShelfItem[];
  filters: FilterDef[];
  sort?: SortSpec;
}

export interface Worksheet {
  id: string;
  name: string;
  spec: VizSpec;
}

export interface TileLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type SlicerType = 'list' | 'dateRange' | 'numericRange';

export interface SlicerState {
  values?: Scalar[];
  min?: Scalar;
  max?: Scalar;
}

export type Tile =
  | { id: string; kind: 'worksheet'; worksheetId: string; layout: TileLayout; title?: string }
  | { id: string; kind: 'text'; text: string; layout: TileLayout }
  | {
      id: string;
      kind: 'slicer';
      field: FieldRef;
      slicerType: SlicerType;
      layout: TileLayout;
      title?: string;
      state?: SlicerState;
    };

export interface DashboardPage {
  id: string;
  name: string;
  tiles: Tile[];
}

export interface Dashboard {
  id: string;
  name: string;
  pages: DashboardPage[];
}

export type ThemeName = 'light' | 'dark';

export const FORMAT_VERSION = 1;

export interface Project {
  formatVersion: number;
  name: string;
  model: Model;
  worksheets: Worksheet[];
  dashboards: Dashboard[];
  theme?: ThemeName;
}

export interface OutputColumn {
  /** Shelf item id this column was produced for. */
  key: string;
  /** Column alias in the result. */
  alias: string;
  role: 'dimension' | 'measure';
  type: DataType;
  label: string;
  dateLevel?: DateLevel;
}

export interface QueryResult {
  columns: OutputColumn[];
  rows: Scalar[][];
  /** True when more rows matched than the row limit; only the first `limit` are returned. */
  truncated: boolean;
  limit: number;
  warnings: string[];
  elapsedMs: number;
}
