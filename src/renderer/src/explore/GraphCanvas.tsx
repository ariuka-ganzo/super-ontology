// The relationship graph, drawn with WebGL by sigma.js. Positions persist across updates, so moving
// the time window grows and shrinks nodes in place instead of reshuffling the picture. Hover,
// selection and highlighting only restyle what is drawn; they never re-query.
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import type { GEdge, GNode, GraphData } from '@shared/explore/graph';

export interface GraphStyle {
  nodeColor(n: GNode): string;
  label(n: GNode): string;
  edgeColor(e: GEdge): string;
  faded: string;
  text: string;
}

export interface GraphCanvasProps {
  data: GraphData;
  edges: GEdge[];
  style: GraphStyle;
  selected: string | null;
  /** Nodes and links to emphasise, for example an insight's. */
  highlight: { nodes: Set<string>; edges: Set<string> } | null;
  /** Fly the camera to this node when it changes. */
  flyTo: { id: string; seq: number } | null;
  onSelect(id: string | null): void;
}

type NodeAttrs = { x: number; y: number; size: number; color: string; label: string; field: number };
type EdgeAttrs = { size: number; color: string; weight: number };

/** A stable starting position: each field gets its own sector of a circle, so layouts are repeatable. */
function seed(n: GNode, index: number, fields: number): { x: number; y: number } {
  const angle = (2 * Math.PI * n.field) / Math.max(1, fields) + (index % 17) * 0.09;
  const r = 10 + (index % 7) * 2;
  return { x: Math.cos(angle) * r, y: Math.sin(angle) * r };
}

export function GraphCanvas({ data, edges, style, selected, highlight, flyTo, onSelect }: GraphCanvasProps): React.JSX.Element {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef(new Graph<NodeAttrs, EdgeAttrs>({ type: 'undirected', multi: false }));
  const sigma = useRef<Sigma<NodeAttrs, EdgeAttrs> | null>(null);
  const hovered = useRef<string | null>(null);
  const state = useRef({ selected, highlight, style });
  state.current = { selected, highlight, style };
  const layoutRun = useRef(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0, settled: false });
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  // Create the renderer once.
  useEffect(() => {
    if (!container.current) return;
    let s: Sigma<NodeAttrs, EdgeAttrs>;
    try {
      s = new Sigma(graph.current, container.current, {
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 9,
        labelDensity: 0.6,
        labelFont: 'system-ui, -apple-system, Segoe UI, sans-serif',
        labelSize: 12,
        labelColor: { attribute: 'labelColor' },
        zIndex: true,
        defaultEdgeType: 'line',
        minCameraRatio: 0.05,
        maxCameraRatio: 4,
        nodeReducer: (node, d) => {
          const { selected: sel, highlight: hl, style: st } = state.current;
          const focus = hovered.current ?? (hl ? null : sel);
          const res: Record<string, unknown> = { ...d, labelColor: st.text };
          if (hl) {
            if (!hl.nodes.has(node)) Object.assign(res, { color: st.faded, label: '', zIndex: 0 });
            else Object.assign(res, { forceLabel: true, zIndex: 2, highlighted: true });
          } else if (focus) {
            const near = node === focus || graph.current.areNeighbors(node, focus);
            if (!near) Object.assign(res, { color: st.faded, label: '', zIndex: 0 });
            else Object.assign(res, { forceLabel: true, zIndex: 2 });
          }
          if (node === sel) Object.assign(res, { highlighted: true, forceLabel: true, zIndex: 3 });
          return res as NodeAttrs;
        },
        edgeReducer: (edge, d) => {
          const { selected: sel, highlight: hl, style: st } = state.current;
          const focus = hovered.current ?? (hl ? null : sel);
          if (hl) return hl.edges.has(edge) ? { ...d, zIndex: 2, size: d.size + 1.5 } : { ...d, color: st.faded, zIndex: 0 };
          if (focus) return graph.current.hasExtremity(edge, focus) ? { ...d, zIndex: 2 } : { ...d, hidden: true };
          return d;
        }
      });
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      return;
    }
    sigma.current = s;
    s.on('enterNode', ({ node }) => {
      hovered.current = node;
      container.current?.style.setProperty('cursor', 'pointer');
      s.refresh({ skipIndexation: true });
    });
    s.on('leaveNode', () => {
      hovered.current = null;
      container.current?.style.setProperty('cursor', 'default');
      s.refresh({ skipIndexation: true });
    });
    s.on('clickNode', ({ node }) => onSelectRef.current(node));
    s.on('clickStage', () => onSelectRef.current(null));
    s.on('doubleClickNode', ({ node, event }) => {
      event.preventSigmaDefault();
      const p = s.getNodeDisplayData(node);
      if (p) void s.getCamera().animate({ x: p.x, y: p.y, ratio: 0.35 }, { duration: 350 });
    });
    // Stops any layout still running (it checks this counter each frame).
    const runs = layoutRun;
    return () => {
      runs.current++;
      s.kill();
      sigma.current = null;
    };
  }, []);

  // Sync nodes and links with the data, keeping existing positions, then let the layout settle.
  useEffect(() => {
    const g = graph.current;
    const fields = Math.max(1, ...data.nodes.map((n) => n.field + 1));
    const maxM = Math.max(1e-9, ...data.nodes.map((n) => n.m));
    const want = new Set(data.nodes.map((n) => n.id));
    let added = 0;
    g.forEachNode((id) => {
      if (!want.has(id)) g.dropNode(id);
    });
    data.nodes.forEach((n, i) => {
      const attrs = { size: 3 + 20 * Math.sqrt(Math.max(0, n.m) / maxM), color: style.nodeColor(n), label: style.label(n), field: n.field };
      if (g.hasNode(n.id)) g.mergeNodeAttributes(n.id, attrs);
      else {
        g.addNode(n.id, { ...seed(n, i, fields), ...attrs });
        added++;
      }
    });
    g.clearEdges();
    const maxShare = Math.max(1e-9, ...edges.map((e) => e.share));
    for (const e of edges) {
      if (!g.hasNode(e.a) || !g.hasNode(e.b)) continue;
      const strength = Math.sqrt(e.share / maxShare);
      g.addEdgeWithKey(e.id, e.a, e.b, {
        size: 0.6 + 4.5 * strength,
        color: style.edgeColor(e),
        // Pairs that occur together more than expected pull harder, so they cluster.
        weight: Math.max(0.05, strength * Math.min(4, Math.max(0.25, e.lift)))
      });
    }
    setCounts({ nodes: g.order, edges: g.size, settled: false });

    // ForceAtlas2 in small slices between frames, so the window stays responsive.
    const run = ++layoutRun.current;
    const total = added > 0 ? 260 : 50;
    const settings = { ...forceAtlas2.inferSettings(g), adjustSizes: true, gravity: 1.2, scalingRatio: 6, slowDown: 6, edgeWeightInfluence: 1 };
    let done = 0;
    const step = (): void => {
      if (run !== layoutRun.current || !g.order) return;
      const slice = Math.min(20, total - done);
      forceAtlas2.assign(g, { iterations: slice, settings });
      done += slice;
      if (done < total) requestAnimationFrame(step);
      else setCounts((c) => ({ ...c, settled: true }));
    };
    requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, edges]);

  // Restyle without touching positions.
  useEffect(() => {
    const g = graph.current;
    for (const n of data.nodes) if (g.hasNode(n.id)) g.mergeNodeAttributes(n.id, { color: style.nodeColor(n), label: style.label(n) });
    sigma.current?.refresh({ skipIndexation: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style, selected, highlight]);

  useEffect(() => {
    const s = sigma.current;
    if (!s || !flyTo || !graph.current.hasNode(flyTo.id)) return;
    const p = s.getNodeDisplayData(flyTo.id);
    if (p) void s.getCamera().animate({ x: p.x, y: p.y, ratio: 0.5 }, { duration: 400 });
  }, [flyTo]);

  return (
    <div className="graph-wrap">
      <div
        ref={container}
        className="graph-canvas"
        data-testid="graph-canvas"
        data-nodes={counts.nodes}
        data-edges={counts.edges}
        data-settled={counts.settled ? 'true' : 'false'}
      />
      {failed && (
        <div className="graph-fallback banner warning" data-testid="graph-unavailable">
          The graph needs WebGL, which this computer's graphics driver does not offer ({failed}). Insights and details still work.
        </div>
      )}
      <div className="graph-tools">
        <button className="small" onClick={() => void sigma.current?.getCamera().animatedReset({ duration: 300 })} title="Fit the whole graph">
          Fit
        </button>
        <button className="small" onClick={() => void sigma.current?.getCamera().animatedZoom({ duration: 200 })} aria-label="Zoom in">
          +
        </button>
        <button className="small" onClick={() => void sigma.current?.getCamera().animatedUnzoom({ duration: 200 })} aria-label="Zoom out">
          −
        </button>
      </div>
    </div>
  );
}
