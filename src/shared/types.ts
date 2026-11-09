// Core data types shared by the main process and the renderer.
// This folder must stay pure TypeScript: no Electron, Node or DuckDB imports.

export type DataType = 'string' | 'integer' | 'number' | 'boolean' | 'date' | 'datetime';

export type Scalar = string | number | boolean | null;

export type FileFormat = 'csv' | 'tsv' | 'parquet' | 'json' | 'excel' | 'sqlite';
/** Database servers: data is copied in on import and on Reload. */
export type ServerFormat = 'postgres' | 'mysql';
export type SourceFormat = FileFormat | ServerFormat;

export function isServerFormat(f: SourceFormat): f is ServerFormat {
  return f === 'postgres' || f === 'mysql';
}

/** Where a database server is. The password is never stored here; see main/credentials.ts. */
export interface ServerConnection {
  /** Stable id that saved passwords are filed under. */
  id: string;
  host: string;
  port: number;
  database: string;
  user: string;
}

export interface TableSource {
  /**
   * Files (including SQLite): absolute path at runtime, stored relative to the project file where possible.
   * Servers: a description such as postgres://user@host:5432/db, for display only.
   */
  path: string;
  format: SourceFormat;
  /** Excel only: sheet name. The first sheet is used when missing. */
  sheet?: string;
  /** Databases: the table to import, unless `query` is set. */
  table?: { schema?: string; name: string };
  /** PostgreSQL and MySQL: a SELECT query run on the server instead of reading a table. */
  query?: string;
  /** PostgreSQL and MySQL. */
  connection?: ServerConnection;
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
  /** Cleaning steps, applied in order to the imported data. `columns` describes the result. */
  steps?: PrepStep[];
}

export type PrepFilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'notContains' | 'startsWith' | 'blank' | 'notBlank';

/**
 * One data cleaning step. Column names refer to the columns as they are after the previous steps.
 * Steps are compiled to SQL in src/shared/prep/prep.ts.
 */
export type PrepStep =
  | { id: string; kind: 'rename'; column: string; to: string }
  | { id: string; kind: 'remove'; columns: string[] }
  | { id: string; kind: 'keep'; columns: string[] }
  | { id: string; kind: 'changeType'; column: string; to: DataType }
  | { id: string; kind: 'filter'; column: string; op: PrepFilterOp; value?: Scalar }
  | { id: string; kind: 'replace'; column: string; find: string; with: string; whole?: boolean }
  | { id: string; kind: 'text'; column: string; op: 'trim' | 'upper' | 'lower' }
  | { id: string; kind: 'fillBlank'; column: string; value: Scalar }
  | { id: string; kind: 'split'; column: string; separator: string; into: string[] }
  | { id: string; kind: 'merge'; columns: string[]; separator: string; to: string }
  | { id: string; kind: 'dedupe'; columns?: string[] }
  | { id: string; kind: 'removeBlankRows' }
  | { id: string; kind: 'keepTop'; n: number }
  | { id: string; kind: 'append'; tableId: string };

export type PrepStepKind = PrepStep['kind'];

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

export const CHART_TYPES = ['bar', 'stackedBar', 'line', 'area', 'scatter', 'pie', 'donut', 'heatmap', 'table', 'pivot', 'kpi'] as const;
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
  /**
   * Id of the dimension item that table calculations run along. The other dimensions partition
   * them. Undefined, or an item no longer in the view, means the first dimension on Columns,
   * then Rows, then Color.
   */
  calcAlong?: string;
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

/** A saved Explore graph: see docs/EXPLORE.md. */
export interface Exploration {
  id: string;
  name: string;
  /** The fields whose values become nodes. 1 to 6. */
  fields: FieldRef[];
  /** Sizes nodes and weights links. */
  measure: { field: FieldRef; agg: AggFn };
  /** A date field for the timeline. Without it there is no timeline and no change over time. */
  time?: FieldRef;
  /** Values shown per field, largest first. */
  topN: number;
  /** Which links to draw. */
  links: 'surprising' | 'strongest' | 'both';
  colorBy: 'field' | 'change';
}

/**
 * Project file format. 2 added data cleaning steps (TableDef.steps); 3 added Explore graphs
 * (Project.explorations). Older files open unchanged.
 * Older app versions refuse newer files instead of silently ignoring what they do not understand.
 */
export const FORMAT_VERSION = 3;

export interface Project {
  formatVersion: number;
  name: string;
  model: Model;
  worksheets: Worksheet[];
  dashboards: Dashboard[];
  /** Explore graphs (format 3). */
  explorations?: Exploration[];
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
