import type { DataType, DateLevel, NumberFormat, Scalar } from './types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Formats a date value (ISO string) for a given date level. */
export function formatDate(v: string, level?: DateLevel): string {
  const y = v.slice(0, 4);
  const m = Number(v.slice(5, 7));
  switch (level) {
    case 'year':
      return y;
    case 'quarter':
      return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
    case 'month':
      return `${MONTHS[m - 1]} ${y}`;
    case 'week':
      return `Week of ${v.slice(0, 10)}`;
    default:
      return v.length > 10 ? v.replace('T', ' ') : v;
  }
}

export function formatNumber(v: number, f?: NumberFormat, type?: DataType): string {
  const style = f?.style ?? 'auto';
  const decimals = f?.decimals;
  const opts = (d: number | undefined, fallbackMax: number): Intl.NumberFormatOptions =>
    d === undefined ? { maximumFractionDigits: fallbackMax } : { minimumFractionDigits: d, maximumFractionDigits: d };
  switch (style) {
    case 'percent':
      return new Intl.NumberFormat('en-US', { style: 'percent', ...opts(decimals, 1) }).format(v);
    case 'currency':
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: f?.currency || 'USD', ...opts(decimals, 2) }).format(v);
    case 'compact':
      return new Intl.NumberFormat('en-US', { notation: 'compact', ...opts(decimals, 1) }).format(v);
    case 'number':
      return new Intl.NumberFormat('en-US', opts(decimals, 2)).format(v);
    default: {
      if (type === 'integer') return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v);
      const abs = Math.abs(v);
      const max = abs >= 1000 ? 0 : abs >= 1 ? 2 : 4;
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: max }).format(v);
    }
  }
}

/** Formats any result value for display. */
export function formatValue(v: Scalar, type: DataType, f?: NumberFormat, level?: DateLevel): string {
  if (v === null) return 'Null';
  if (typeof v === 'number') return formatNumber(v, f, type);
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (type === 'date' || type === 'datetime') return formatDate(v, level);
  return v;
}
