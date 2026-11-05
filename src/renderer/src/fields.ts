import { calcInfo, effectiveType, type VType } from '@shared/formula/check';
import { defaultAgg } from '@shared/compiler/compile';
import type { AggFn, DataType, FieldRef, Model } from '@shared/types';

export interface FieldInfo {
  ref: FieldRef;
  key: string;
  name: string;
  tableId?: string;
  tableName?: string;
  role: 'dimension' | 'measure';
  vtype: VType | 'unknown';
  dataType?: DataType;
  /** Saved calculation: row-level calculated column or aggregate measure. */
  calcKind?: 'column' | 'measure';
  error?: string;
}

export function fieldKey(ref: FieldRef): string {
  return ref.kind === 'column' ? `col:${ref.table}:${ref.column}` : `calc:${ref.id}`;
}

function typeToVType(t: DataType): VType {
  return t === 'integer' ? 'number' : t;
}

/** Every field in the model, classified into dimensions and measures. */
export function listFields(model: Model): FieldInfo[] {
  const out: FieldInfo[] = [];
  for (const t of model.tables) {
    for (const c of t.columns) {
      const dt = effectiveType(c);
      const ref: FieldRef = { kind: 'column', table: t.id, column: c.name };
      out.push({
        ref,
        key: fieldKey(ref),
        name: c.name,
        tableId: t.id,
        tableName: t.name,
        role: dt === 'integer' || dt === 'number' ? (/(^|_|\s)(id|key|code)$/i.test(c.name) ? 'dimension' : 'measure') : 'dimension',
        vtype: typeToVType(dt),
        dataType: dt
      });
    }
  }
  for (const c of model.calcs) {
    const ref: FieldRef = { kind: 'calc', id: c.id };
    const info = calcInfo(model, c.id);
    const level = info.level;
    const measure = !info.ok || level === 'agg' || level === 'tcalc' || level === 'lod' || (level !== 'const' && info.vtype === 'number');
    out.push({
      ref,
      key: fieldKey(ref),
      name: c.name,
      role: measure ? 'measure' : 'dimension',
      vtype: info.vtype ?? 'unknown',
      calcKind: level === 'agg' || level === 'tcalc' || level === 'lod' ? 'measure' : 'column',
      error: info.error?.message
    });
  }
  return out;
}

export function fieldInfo(model: Model, ref: FieldRef): FieldInfo | undefined {
  const key = fieldKey(ref);
  return listFields(model).find((f) => f.key === key);
}

export function isAggregateCalc(f: FieldInfo | undefined): boolean {
  return !!f && f.calcKind === 'measure';
}

export function defaultAggFor(f: FieldInfo | undefined): AggFn | undefined {
  if (!f || isAggregateCalc(f)) return undefined;
  return defaultAgg(f.vtype === 'unknown' ? 'number' : f.vtype);
}

export function isTemporal(f: FieldInfo | undefined): boolean {
  return !!f && (f.vtype === 'date' || f.vtype === 'datetime');
}
