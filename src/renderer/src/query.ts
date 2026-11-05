import { useEffect, useRef, useState } from 'react';
import type { FilterDef, Model, QueryResult, VizSpec } from '@shared/types';
import { compileViz } from '@shared/compiler/compile';
import { newId } from './ids';

export interface QueryState {
  result: QueryResult | null;
  error: string | null;
  loading: boolean;
}

export interface QueryHandle extends QueryState {
  /** Cancels the running query, if any. */
  cancel(): void;
}

const cache = new Map<string, QueryResult>();
const CACHE_LIMIT = 60;

/** Clears cached results, for example after a table is reloaded. */
export function clearQueryCache(): void {
  cache.clear();
}

/**
 * Runs a view query in the main process. A newer request cancels the one still running,
 * so dragging fields around never queues up stale work.
 */
export function useVizQuery(model: Model, spec: VizSpec | null, externalFilters?: FilterDef[], maxRows?: number): QueryHandle {
  const [state, setState] = useState<QueryState>({ result: null, error: null, loading: false });
  const running = useRef<string | null>(null);
  const key = spec ? JSON.stringify([model, spec, externalFilters ?? [], maxRows ?? null]) : '';

  useEffect(() => {
    if (!spec) {
      setState({ result: null, error: null, loading: false });
      return;
    }
    // Compile locally first so errors show instantly without a round trip.
    try {
      compileViz(spec, model, { externalFilters, maxRows });
    } catch (e) {
      setState({ result: null, error: (e as Error).message, loading: false });
      return;
    }
    const cached = cache.get(key);
    if (cached) {
      setState({ result: cached, error: null, loading: false });
      return;
    }
    const requestId = newId('q');
    if (running.current) void window.facet.cancel(running.current);
    running.current = requestId;
    setState((s) => ({ ...s, loading: true }));
    let alive = true;
    const timer = setTimeout(() => {
      window.facet
        .query({ requestId, model, spec, externalFilters, maxRows })
        .then((result) => {
          cache.set(key, result);
          if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
          if (alive) setState({ result, error: null, loading: false });
        })
        .catch((e: Error & { code?: string }) => {
          if (!alive || e.code === 'cancelled') return;
          setState({ result: null, error: e.message, loading: false });
        })
        .finally(() => {
          if (running.current === requestId) running.current = null;
        });
    }, 30);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // The key captures every input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(
    () => () => {
      if (running.current) void window.facet.cancel(running.current);
    },
    []
  );

  const cancel = (): void => {
    if (!running.current) return;
    void window.facet.cancel(running.current);
    running.current = null;
    setState({ result: null, error: 'Query cancelled. Change the view or press Run again to retry.', loading: false });
  };
  return { ...state, cancel };
}
