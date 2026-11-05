import { describe, expect, it } from 'vitest';
import { formatDate, formatNumber, formatValue } from '@shared/format';
import { classifyCardinality, suggestRelationships } from '@shared/model/relationships';
import { chartFits, recommendCharts } from '@shared/recommend/recommend';
import type { Model } from '@shared/types';

describe('chart recommendation', () => {
  it('recommends a KPI card for measures only', () => {
    expect(recommendCharts({ dims: [], measures: 1 })[0].type).toBe('kpi');
  });
  it('recommends a line for a date and a measure', () => {
    expect(recommendCharts({ dims: [{ temporal: true }], measures: 1 })[0].type).toBe('line');
  });
  it('recommends bars, then donut and pie, for a category and a measure', () => {
    const r = recommendCharts({ dims: [{ temporal: false }], measures: 1 }).map((x) => x.type);
    expect(r.slice(0, 3)).toEqual(['bar', 'donut', 'pie']);
    expect(r).toContain('table');
  });
  it('recommends a heatmap for two categories and a measure', () => {
    expect(recommendCharts({ dims: [{ temporal: false }, { temporal: false }], measures: 1 })[0].type).toBe('heatmap');
  });
  it('recommends scatter for two measures', () => {
    expect(recommendCharts({ dims: [{ temporal: false }], measures: 2 })[0].type).toBe('scatter');
  });
  it('knows which charts fit', () => {
    expect(chartFits('pie', { dims: [{ temporal: false }], measures: 2 })).toBe(false);
    expect(chartFits('table', { dims: [{ temporal: false }], measures: 0 })).toBe(true);
    expect(recommendCharts({ dims: [{ temporal: false }, { temporal: false }, { temporal: false }], measures: 1 })[0].type).toBe('pivot');
  });
});

describe('relationship suggestions', () => {
  const t = (id: string, name: string, cols: [string, 'integer' | 'string'][]) => ({
    id,
    name,
    source: { path: '', format: 'csv' as const },
    rowCount: 1,
    columns: cols.map(([n, type]) => ({ name: n, sourceType: '', type }))
  });
  it('matches same-named keys and table-named ids', () => {
    const model: Model = {
      tables: [
        t('o', 'Orders', [['order_id', 'integer'], ['customer_id', 'integer'], ['Product Code', 'string']]),
        t('c', 'Customers', [['id', 'integer'], ['name', 'string']]),
        t('p', 'Products', [['product_code', 'string'], ['name', 'string']])
      ],
      relationships: [],
      calcs: []
    };
    const s = suggestRelationships(model);
    expect(s).toContainEqual(expect.objectContaining({ fromTable: 'o', fromColumn: 'customer_id', toTable: 'c', toColumn: 'id' }));
    expect(s).toContainEqual(expect.objectContaining({ fromTable: 'o', fromColumn: 'Product Code', toTable: 'p', toColumn: 'product_code' }));
    // name/name is text with the same name in both tables, but a pair already has a suggestion.
    expect(s.filter((x) => x.fromTable === 'c' && x.toTable === 'p')).toHaveLength(1);
  });
  it('classifies cardinality', () => {
    expect(classifyCardinality(false, true)).toBe('many-to-one');
    expect(classifyCardinality(true, false)).toBe('one-to-many');
    expect(classifyCardinality(true, true)).toBe('one-to-one');
    expect(classifyCardinality(false, false)).toBe('many-to-many');
  });
});

describe('formatting', () => {
  it('formats dates by level', () => {
    expect(formatDate('2024-05-01', 'month')).toBe('May 2024');
    expect(formatDate('2024-05-01', 'quarter')).toBe('2024 Q2');
    expect(formatDate('2024-05-01', 'year')).toBe('2024');
    expect(formatDate('2024-05-01T10:00:00')).toBe('2024-05-01 10:00:00');
  });
  it('formats numbers', () => {
    expect(formatNumber(1234.567)).toBe('1,235');
    expect(formatNumber(0.1234, { style: 'percent', decimals: 1 })).toBe('12.3%');
    expect(formatNumber(1234.5, { style: 'currency', currency: 'EUR' })).toBe('€1,234.50');
    expect(formatNumber(1234567, { style: 'compact' })).toBe('1.2M');
    expect(formatValue(null, 'number')).toBe('Null');
  });
});
