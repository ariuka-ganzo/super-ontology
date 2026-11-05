import { effectiveType } from '../formula/check';
import type { Cardinality, DataType, Model, Relationship } from '../types';

export interface RelationshipSuggestion {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
  reason: string;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_\-.]/g, '');
}

function singular(s: string): string {
  const n = norm(s);
  if (n.endsWith('ies')) return n.slice(0, -3) + 'y';
  if (n.endsWith('ses')) return n.slice(0, -2);
  if (n.endsWith('s')) return n.slice(0, -1);
  return n;
}

function joinable(a: DataType, b: DataType): boolean {
  const num = (t: DataType): boolean => t === 'integer' || t === 'number';
  if (num(a) && num(b)) return true;
  return a === b && a !== 'boolean';
}

/**
 * Suggests relationships between tables from column names and types:
 * the same name in both tables (orders.customer_id = customers.customer_id), or
 * a key named after the other table (orders.customer_id = customers.id).
 */
export function suggestRelationships(model: Model): RelationshipSuggestion[] {
  const out: RelationshipSuggestion[] = [];
  const exists = (a: string, ac: string, b: string, bc: string): boolean =>
    model.relationships.some(
      (r) =>
        (r.fromTable === a && r.fromColumn === ac && r.toTable === b && r.toColumn === bc) ||
        (r.fromTable === b && r.fromColumn === bc && r.toTable === a && r.toColumn === ac)
    ) || out.some((s) => (s.fromTable === a && s.toTable === b) || (s.fromTable === b && s.toTable === a));
  const tables = model.tables;
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      for (const ca of a.columns) {
        for (const cb of b.columns) {
          if (!joinable(effectiveType(ca), effectiveType(cb))) continue;
          const na = norm(ca.name);
          const nb = norm(cb.name);
          let reason = '';
          if (na === nb && (na.endsWith('id') || na.endsWith('key') || na.endsWith('code'))) reason = `Both tables have ${ca.name}`;
          else if (nb === 'id' && na === singular(b.name) + 'id') reason = `${ca.name} looks like the id of ${b.name}`;
          else if (na === 'id' && nb === singular(a.name) + 'id') reason = `${cb.name} looks like the id of ${a.name}`;
          else if (na === nb && na.length > 2) reason = `Both tables have ${ca.name}`;
          if (!reason || exists(a.id, ca.name, b.id, cb.name)) continue;
          out.push({ fromTable: a.id, fromColumn: ca.name, toTable: b.id, toColumn: cb.name, reason });
        }
      }
    }
  }
  return out;
}

/** Cardinality from whether each side's key values are unique. */
export function classifyCardinality(fromUnique: boolean, toUnique: boolean): Cardinality {
  if (fromUnique && toUnique) return 'one-to-one';
  if (fromUnique) return 'one-to-many';
  if (toUnique) return 'many-to-one';
  return 'many-to-many';
}

export function cardinalityLabel(r: Pick<Relationship, 'cardinality'>): string {
  switch (r.cardinality) {
    case 'one-to-one':
      return 'One to one';
    case 'one-to-many':
      return 'One to many';
    case 'many-to-one':
      return 'Many to one';
    case 'many-to-many':
      return 'Many to many';
  }
}
