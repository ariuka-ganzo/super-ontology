// The measure over time, with a draggable window and a play button that steps through periods.
import { useEffect, useRef, useState } from 'react';
import type { TimeWindow } from '@shared/explore/graph';

export function Timeline({
  periods,
  values,
  window: w,
  prev,
  mark,
  label,
  unit,
  onChange
}: {
  /** The period length in words: day, week, month, quarter or year. */
  unit: string;
  periods: string[];
  values: number[];
  window: TimeWindow;
  prev: TimeWindow | null;
  /** A period to point at, for example an insight's spike. */
  mark: number | null;
  label(p: string): string;
  onChange(w: TimeWindow): void;
}): React.JSX.Element {
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ start: number; mode: 'new' | 'move'; offset: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const n = periods.length;
  const max = Math.max(1e-9, ...values);
  const len = w.to - w.from + 1;

  const indexAt = (clientX: number): number => {
    const r = svg.current?.getBoundingClientRect();
    if (!r || !n) return 0;
    return Math.max(0, Math.min(n - 1, Math.floor(((clientX - r.left) / r.width) * n)));
  };

  // Play: slide the window forward one period at a time, starting over at the end.
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      const next = w.to + 1 < n ? { from: w.from + 1, to: w.to + 1 } : { from: 0, to: len - 1 };
      onChange(next);
    }, 650);
    return () => clearInterval(t);
  }, [playing, w, n, len, onChange]);

  const all = w.from === 0 && w.to === n - 1;
  return (
    <div className="timeline" data-testid="timeline">
      <div className="timeline-head">
        <button className="small" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play through time'} data-testid="timeline-play">
          {playing ? '❚❚' : '▶'}
        </button>
        <span data-testid="timeline-window">
          <b>
            {label(periods[w.from] ?? '')}
            {len > 1 ? ` – ${label(periods[w.to] ?? '')}` : ''}
          </b>
          <span className="muted">
            {prev ? `  compared with the ${len > 1 ? `${len} ${unit}s` : unit} before` : all ? '  all time' : '  (nothing before this to compare with)'}
          </span>
        </span>
        <span className="grow" />
        {!all && (
          <button className="small ghost" onClick={() => onChange({ from: 0, to: n - 1 })}>
            All time
          </button>
        )}
        {n >= 8 && (
          <button
            className="small ghost"
            onClick={() => onChange({ from: Math.max(0, n - Math.ceil(n / 4)), to: n - 1 })}
            title="The latest quarter of the range, compared with the quarter before"
          >
            Latest
          </button>
        )}
      </div>
      <svg
        ref={svg}
        className="timeline-bars"
        viewBox={`0 0 ${Math.max(1, n)} 100`}
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          (e.target as Element).setPointerCapture?.(e.pointerId);
          const i = indexAt(e.clientX);
          drag.current = i >= w.from && i <= w.to && !all ? { start: i, mode: 'move', offset: i - w.from } : { start: i, mode: 'new', offset: 0 };
          if (drag.current.mode === 'new') onChange({ from: i, to: i });
          setPlaying(false);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const i = indexAt(e.clientX);
          if (d.mode === 'new') onChange({ from: Math.min(d.start, i), to: Math.max(d.start, i) });
          else {
            const from = Math.max(0, Math.min(n - len, i - d.offset));
            if (from !== w.from) onChange({ from, to: from + len - 1 });
          }
        }}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => onChange({ from: 0, to: n - 1 })}
        role="slider"
        aria-label="Time window"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={w.to}
      >
        {prev && <rect x={prev.from} y={0} width={prev.to - prev.from + 1} height={100} className="timeline-prev" />}
        <rect x={w.from} y={0} width={len} height={100} className="timeline-window" />
        {values.map((v, i) => (
          <rect
            key={i}
            x={i + 0.12}
            width={0.76}
            y={100 - (v / max) * 92}
            height={(v / max) * 92}
            className={i >= w.from && i <= w.to ? 'timeline-bar in' : 'timeline-bar'}
          />
        ))}
        {mark !== null && mark >= 0 && <rect x={mark + 0.3} width={0.4} y={0} height={100} className="timeline-mark" />}
      </svg>
      <div className="timeline-axis faint">
        <span>{label(periods[0] ?? '')}</span>
        <span>Drag to choose a window · drag inside it to move it · double-click for all time</span>
        <span>{label(periods[n - 1] ?? '')}</span>
      </div>
    </div>
  );
}
