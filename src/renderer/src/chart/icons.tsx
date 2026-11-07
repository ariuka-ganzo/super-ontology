import type { ChartType } from '@shared/types';

const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function ChartIcon({ type }: { type: ChartType }): React.JSX.Element {
  switch (type) {
    case 'bar':
      return (
        <svg viewBox="0 0 26 20">
          <path {...s} d="M4 18V9M10 18V4M16 18V11M22 18V7" strokeWidth={3} />
        </svg>
      );
    case 'stackedBar':
      return (
        <svg viewBox="0 0 26 20">
          <path {...s} d="M6 18v-6M13 18v-8M20 18v-5" strokeWidth={4} />
          <path {...s} d="M6 12V6M13 10V3M20 13V8" strokeWidth={4} opacity={0.45} />
        </svg>
      );
    case 'line':
      return (
        <svg viewBox="0 0 26 20">
          <path {...s} d="M2 16l6-6 5 3 6-9 5 4" />
        </svg>
      );
    case 'area':
      return (
        <svg viewBox="0 0 26 20">
          <path d="M2 18V14l6-6 5 3 6-8 5 4v11z" fill="currentColor" opacity={0.35} />
          <path {...s} d="M2 14l6-6 5 3 6-8 5 4" />
        </svg>
      );
    case 'scatter':
      return (
        <svg viewBox="0 0 26 20">
          {[
            [5, 14],
            [9, 9],
            [13, 12],
            [16, 6],
            [20, 8],
            [22, 3]
          ].map(([x, y]) => (
            <circle key={`${x}${y}`} cx={x} cy={y} r={1.8} fill="currentColor" />
          ))}
        </svg>
      );
    case 'pie':
      return (
        <svg viewBox="0 0 26 20">
          <circle {...s} cx={13} cy={10} r={8} />
          <path {...s} d="M13 10V2M13 10l7 4" />
        </svg>
      );
    case 'donut':
      return (
        <svg viewBox="0 0 26 20">
          <circle {...s} cx={13} cy={10} r={8} strokeWidth={4} opacity={0.45} />
          <path {...s} d="M13 2a8 8 0 0 1 7 12" strokeWidth={4} />
        </svg>
      );
    case 'heatmap':
      return (
        <svg viewBox="0 0 26 20">
          {[0, 1, 2].flatMap((r) =>
            [0, 1, 2, 3].map((c) => (
              <rect key={`${r}${c}`} x={3 + c * 5.2} y={2 + r * 5.5} width={4.6} height={4.9} fill="currentColor" opacity={0.2 + ((r * 4 + c) % 5) * 0.18} />
            ))
          )}
        </svg>
      );
    case 'table':
      return (
        <svg viewBox="0 0 26 20">
          <rect {...s} x={3} y={3} width={20} height={14} rx={1} />
          <path {...s} d="M3 8h20M3 12.5h20M11 3v14" />
        </svg>
      );
    case 'pivot':
      return (
        <svg viewBox="0 0 26 20">
          <rect {...s} x={3} y={3} width={20} height={14} rx={1} />
          <path {...s} d="M3 7.5h20M9 3v14M15 7.5v9.5" />
        </svg>
      );
    case 'kpi':
      return (
        <svg viewBox="0 0 26 20">
          <text x={13} y={14} textAnchor="middle" fontSize={11} fontWeight={700} fill="currentColor">
            42
          </text>
        </svg>
      );
  }
}
