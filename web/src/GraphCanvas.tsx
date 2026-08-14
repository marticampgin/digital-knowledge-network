import { Maximize, Minus, Plus } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphData, GraphLink, GraphNode } from "./types";

const COLORS: Record<string, string> = { text: "#67d8ff", markdown: "#67d8ff", telegram: "#9d83ef", image: "#9d83ef", audio: "#f2bd60" };
const idOf = (value: string | GraphNode) => typeof value === "string" ? value : value.id;

export const GraphCanvas = memo(function GraphCanvas({ data, selectedId, onSelect }: { data: GraphData; selectedId: string | null; onSelect: (node: GraphNode | null) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 900, height: 700 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const neighbors = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;
    for (const link of data.links) {
      if (idOf(link.source) === selectedId) ids.add(idOf(link.target));
      if (idOf(link.target) === selectedId) ids.add(idOf(link.source));
    }
    return ids;
  }, [data.links, selectedId]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) });
    });
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!data.nodes.length) return;
    const graph = graphRef.current;
    const charge = graph?.d3Force("charge") as { strength?: (value: number) => unknown } | undefined;
    const link = graph?.d3Force("link") as { distance?: (value: (link: GraphLink) => number) => unknown; strength?: (value: (link: GraphLink) => number) => unknown } | undefined;
    charge?.strength?.(-75);
    link?.distance?.((edge) => edge.type === "shared_tag" ? 48 : 72);
    link?.strength?.((edge) => edge.type === "shared_tag" ? .55 : .11);
    graph?.d3ReheatSimulation();
    window.setTimeout(() => graph?.zoomToFit(500, size.width < 600 ? 44 : 80), 350);
  }, [data.nodes.length, size.width]);

  useEffect(() => {
    if (!selectedId) return;
    const node = data.nodes.find((item) => item.id === selectedId);
    if (node?.x === undefined || node.y === undefined) return;
    graphRef.current?.centerAt(node.x, node.y, 450);
    graphRef.current?.zoom(Math.max(graphRef.current.zoom(), .95), 450);
  }, [data.nodes, selectedId]);

  return <div className="graph-wrap" ref={wrapRef}>
    <div className="visually-hidden" aria-label="Knowledge graph nodes">
      {data.nodes.map((node) => <button key={node.id} onClick={() => onSelect(node)}>{node.label}</button>)}
    </div>
    {data.nodes.length ? <ForceGraph2D ref={graphRef} width={size.width} height={size.height} graphData={data}
      backgroundColor="rgba(0,0,0,0)" d3AlphaDecay={0.035} d3VelocityDecay={0.25} cooldownTicks={90}
      onEngineStop={() => {
        const graph = graphRef.current;
        const selected = data.nodes.find((item) => item.id === selectedId);
        if (selected?.x !== undefined && selected.y !== undefined) {
          graph?.centerAt(selected.x, selected.y, 450);
          graph?.zoom(Math.max(graph.zoom(), .95), 450);
        } else {
          graph?.zoomToFit(450, size.width < 600 ? 42 : 78);
        }
      }}
      nodeLabel={(node) => node.label}
      linkColor={(link) => selectedId && (idOf(link.source) === selectedId || idOf(link.target) === selectedId) ? "rgba(117,220,255,.9)" : link.type === "shared_tag" ? "rgba(143,116,220,.34)" : "rgba(105,126,151,.42)"}
      linkWidth={(link) => selectedId && (idOf(link.source) === selectedId || idOf(link.target) === selectedId) ? 1.25 : Math.max(.35, link.weight)}
      linkLineDash={(link) => link.type === "shared_tag" ? [4, 6] : null}
      nodeCanvasObjectMode={() => "replace"}
      nodePointerAreaPaint={(node, color, context) => { context.fillStyle = color; context.beginPath(); context.arc(node.x ?? 0, node.y ?? 0, 8, 0, Math.PI * 2); context.fill(); }}
      nodeCanvasObject={(node, context, scale) => drawNode(node, context, scale, node.id === selectedId, neighbors.has(node.id), node.id === hoveredId, size.width < 600)}
      onNodeHover={(node) => setHoveredId(node?.id ?? null)}
      onNodeClick={(node) => onSelect(node)} onBackgroundClick={() => onSelect(null)}
    /> : <div className="empty-state"><div className="empty-mark" /><h1>Your network begins with one note.</h1><p>Import text, a screenshot, or an audio recording. The source stays local and traceable.</p></div>}
    <div className="legend" aria-label="Node type legend"><Legend color="#67d8ff" label="Book" /><Legend color="#9d83ef" label="Capture" /><Legend color="#f2bd60" label="Audio" /></div>
    <div className="zoom-controls">
      <button onClick={() => graphRef.current?.zoom((graphRef.current.zoom() ?? 1) * 1.35, 250)} aria-label="Zoom in"><Plus /></button>
      <button onClick={() => graphRef.current?.zoom((graphRef.current.zoom() ?? 1) / 1.35, 250)} aria-label="Zoom out"><Minus /></button>
      <button onClick={() => graphRef.current?.zoomToFit(400, 70)} aria-label="Fit graph"><Maximize /></button>
    </div>
  </div>;
});

function drawNode(node: GraphNode, context: CanvasRenderingContext2D, scale: number, selected: boolean, neighbor: boolean, hovered: boolean, compact: boolean) {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const active = selected || neighbor || hovered;
  const color = COLORS[node.sourceKind] ?? COLORS.text ?? "#67d8ff";
  const radius = (selected ? 7.5 : active ? 5 : 4) / scale;
  if (active) {
    const glow = context.createRadialGradient(x, y, radius, x, y, radius * 4.5);
    glow.addColorStop(0, `${color}72`); glow.addColorStop(1, "transparent");
    context.fillStyle = glow; context.beginPath(); context.arc(x, y, radius * 4.5, 0, Math.PI * 2); context.fill();
  }
  context.fillStyle = color; context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  context.strokeStyle = selected ? "#eefaff" : "rgba(230,247,255,.72)"; context.lineWidth = selected ? 1.4 : .65; context.stroke();
  if (selected || hovered || (!compact && scale > 1.25)) {
    const fontSize = (selected ? 12.5 : 11.5) / scale;
    context.font = `${selected ? 550 : 400} ${fontSize}px Inter, sans-serif`;
    context.textAlign = "center"; context.textBaseline = "top";
    context.fillStyle = selected ? "#f1f7fb" : "rgba(217,228,236,.82)";
    const label = node.label.length > 34 ? `${node.label.slice(0, 32)}…` : node.label;
    context.fillText(label, x, y + radius + (5 / scale));
  }
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span><i style={{ background: color, boxShadow: `0 0 10px ${color}` }} />{label}</span>;
}
