// Runtime validation for everything that crosses the IPC boundary or is read from a project file.
import { z } from 'zod';
import { AGG_FNS, CHART_TYPES, DATE_LEVELS } from './types';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const name = z.string().min(1).max(512);
const text = z.string().max(100_000);
const dataType = z.enum(['string', 'integer', 'number', 'boolean', 'date', 'datetime']);
const scalar = z.union([z.string().max(10_000), z.number(), z.boolean(), z.null()]);
const dateLevel = z.enum(DATE_LEVELS);
const agg = z.enum(AGG_FNS);

export const fieldRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('column'), table: id, column: name }),
  z.object({ kind: z.literal('calc'), id })
]);

const filterBase = { id, field: fieldRefSchema, context: z.boolean().optional() };

export const filterSchema = z.discriminatedUnion('kind', [
  z.object({ ...filterBase, kind: z.literal('values'), dateLevel: dateLevel.optional(), values: z.array(scalar).max(10_000), exclude: z.boolean().optional() }),
  z.object({ ...filterBase, kind: z.literal('range'), dateLevel: dateLevel.optional(), min: scalar.optional(), max: scalar.optional() }),
  z.object({
    ...filterBase,
    kind: z.literal('measure'),
    agg: agg.optional(),
    op: z.enum(['>', '>=', '<', '<=', '=', '!=']),
    value: z.number()
  }),
  z.object({
    ...filterBase,
    kind: z.literal('topN'),
    dateLevel: dateLevel.optional(),
    n: z.number().int().min(1).max(1_000_000),
    by: z.object({ field: fieldRefSchema, agg: agg.optional() }),
    direction: z.enum(['top', 'bottom'])
  })
]);

export const columnSchema = z.object({
  name,
  sourceType: z.string().max(512),
  type: dataType,
  override: dataType.optional()
});

export const sourceSchema = z.object({
  path: z.string().min(1).max(4096),
  format: z.enum(['csv', 'tsv', 'parquet', 'json', 'excel']),
  sheet: z.string().max(512).optional()
});

export const tableSchema = z.object({
  id,
  name,
  source: sourceSchema,
  columns: z.array(columnSchema).max(5000),
  rowCount: z.number().int().min(0),
  filters: z.array(filterSchema).max(200).optional()
});

export const relationshipSchema = z.object({
  id,
  fromTable: id,
  fromColumn: name,
  toTable: id,
  toColumn: name,
  cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-one', 'many-to-many'])
});

export const calcSchema = z.object({ id, name, formula: text });

export const modelSchema = z.object({
  tables: z.array(tableSchema).max(200),
  relationships: z.array(relationshipSchema).max(1000),
  calcs: z.array(calcSchema).max(2000)
});

const numberFormat = z.object({
  style: z.enum(['auto', 'number', 'percent', 'currency', 'compact']),
  decimals: z.number().int().min(0).max(10).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional()
});

export const shelfItemSchema = z.object({
  id,
  field: fieldRefSchema,
  role: z.enum(['dimension', 'measure']),
  agg: agg.optional(),
  dateLevel: dateLevel.optional(),
  format: numberFormat.optional()
});

export const vizSpecSchema = z.object({
  chartType: z.enum([...CHART_TYPES, 'auto']),
  columns: z.array(shelfItemSchema).max(50),
  rows: z.array(shelfItemSchema).max(50),
  color: shelfItemSchema.optional(),
  size: shelfItemSchema.optional(),
  label: shelfItemSchema.optional(),
  tooltip: z.array(shelfItemSchema).max(50),
  filters: z.array(filterSchema).max(200),
  sort: z.object({ itemId: id, dir: z.enum(['asc', 'desc']) }).optional()
});

const layout = z.object({
  x: z.number().int().min(0).max(1000),
  y: z.number().int().min(0).max(100_000),
  w: z.number().int().min(1).max(1000),
  h: z.number().int().min(1).max(1000)
});

export const tileSchema = z.discriminatedUnion('kind', [
  z.object({ id, kind: z.literal('worksheet'), worksheetId: id, layout, title: z.string().max(512).optional() }),
  z.object({ id, kind: z.literal('text'), text: z.string().max(20_000), layout }),
  z.object({
    id,
    kind: z.literal('slicer'),
    field: fieldRefSchema,
    slicerType: z.enum(['list', 'dateRange', 'numericRange']),
    layout,
    title: z.string().max(512).optional(),
    state: z.object({ values: z.array(scalar).max(10_000).optional(), min: scalar.optional(), max: scalar.optional() }).optional()
  })
]);

export const projectSchema = z.object({
  formatVersion: z.number().int(),
  name: z.string().max(512),
  model: modelSchema,
  worksheets: z.array(z.object({ id, name, spec: vizSpecSchema })).max(1000),
  dashboards: z
    .array(z.object({ id, name, pages: z.array(z.object({ id, name, tiles: z.array(tileSchema).max(200) })).min(1).max(100) }))
    .max(200),
  theme: z.enum(['light', 'dark']).optional()
});

export const queryRequestSchema = z.object({
  requestId: z.string().min(1).max(128),
  model: modelSchema,
  spec: vizSpecSchema,
  externalFilters: z.array(filterSchema).max(500).optional(),
  maxRows: z.number().int().min(1).max(1_000_000).optional()
});
