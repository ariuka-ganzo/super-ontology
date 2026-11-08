// The typed API the preload script exposes to the renderer as `window.ontology`.
import type { ColumnDef, FilterDef, Model, PrepStep, Project, QueryResult, Relationship, Scalar, TableDef, TableSource, VizSpec } from './types';

/** A table after its cleaning steps were applied. */
export interface PrepareResult {
  columns: ColumnDef[];
  rowCount: number;
  /** The first step that could not be applied. The table reflects the steps before it. */
  stepError?: { stepId: string; message: string };
}

export interface ImportResult extends PrepareResult {
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
  /** Cleaning steps that could not be applied. */
  stepErrors: { tableId: string; stepId: string; message: string }[];
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

export interface OntologyApi {
  chooseDataFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  sourceFromPath(path: string): Promise<TableSource & { sheets?: string[] }>;
  importTable(tableId: string, source: TableSource, steps?: PrepStep[]): Promise<ImportResult>;
  /** Re-applies a table's cleaning steps to its already imported data. */
  applySteps(tableId: string, steps: PrepStep[]): Promise<PrepareResult>;
  dropTable(tableId: string): Promise<void>;
  /** With `uptoStep`, the data as it is right after that cleaning step. */
  preview(table: TableDef, limit: number, offset: number, uptoStep?: string): Promise<PreviewResult>;
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
