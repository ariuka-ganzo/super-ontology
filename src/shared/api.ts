// The typed API the preload script exposes to the renderer as `window.facet`.
import type { ColumnDef, FilterDef, Model, Project, QueryResult, Relationship, Scalar, TableDef, TableSource, VizSpec } from './types';

export interface ImportResult {
  columns: ColumnDef[];
  rowCount: number;
  elapsedMs: number;
}

export interface PreviewResult {
  columns: string[];
  rows: Scalar[][];
  total: number;
}

export interface ColumnProfile {
  column: string;
  total: number;
  nulls: number;
  distinct: number;
  min: Scalar;
  max: Scalar;
  /** Numeric and date columns: equal-width bins. Text and boolean columns: the most common values. */
  histogram: { label: string; count: number }[];
  histogramKind: 'bins' | 'top';
}

export interface CardinalityResult {
  cardinality: Relationship['cardinality'];
  fromUnique: boolean;
  toUnique: boolean;
  /** Share of non-null `from` keys that have a match on the `to` side. */
  matchRate: number;
}

export interface OpenProjectResult {
  project: Project;
  path: string | null;
  /** Tables that could not be loaded, with a plain-language reason. */
  tableErrors: { tableId: string; message: string }[];
  /** Tables whose columns changed since the project was saved. */
  changed: { tableId: string; added: string[]; removed: string[] }[];
}

export interface StartupInfo {
  firstRun: boolean;
  /** A project file the app was launched with, for example by double-clicking it. */
  openPath: string | null;
  platform: string;
  version: string;
}

export type MenuAction = 'new' | 'open' | 'save' | 'saveAs' | 'import' | 'undo' | 'redo' | 'openSample' | 'toggleTheme' | 'about';

export interface QueryRequest {
  requestId: string;
  model: Model;
  spec: VizSpec;
  externalFilters?: FilterDef[];
  maxRows?: number;
}

export interface FacetApi {
  chooseDataFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  sourceFromPath(path: string): Promise<TableSource & { sheets?: string[] }>;
  importTable(tableId: string, source: TableSource): Promise<ImportResult>;
  dropTable(tableId: string): Promise<void>;
  preview(table: TableDef, limit: number, offset: number): Promise<PreviewResult>;
  profile(table: TableDef, column: string): Promise<ColumnProfile>;
  cardinality(model: Model, rel: Omit<Relationship, 'id' | 'cardinality'>): Promise<CardinalityResult>;
  query(req: QueryRequest): Promise<QueryResult>;
  cancel(requestId: string): Promise<void>;
  openProject(path?: string): Promise<OpenProjectResult | null>;
  openSample(): Promise<OpenProjectResult>;
  saveProject(project: Project, path: string | null, saveAs: boolean): Promise<string | null>;
  exportPng(dataUrl: string, name: string): Promise<string | null>;
  exportCsv(req: QueryRequest, name: string): Promise<string | null>;
  exportPdf(name: string): Promise<string | null>;
  startup(): Promise<StartupInfo>;
  setTitle(title: string, dirty: boolean): Promise<void>;
  onMenu(cb: (action: MenuAction) => void): () => void;
  /** A project file was opened from the operating system while the app is running. */
  onOpenPath(cb: (path: string) => void): () => void;
}
