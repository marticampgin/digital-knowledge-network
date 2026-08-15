import { Maximize, Minus, Plus } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphData, GraphLink, GraphNode } from "./types";

const COLORS: Record<string, string> = { text: "#62d7f5", markdown: "#62d7f5", telegram: "#62d7f5", image: "#9b83f0", audio: "#e9b95f" };
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
  const labeledIds = useMemo(() => {
    const degree = new Map(data.nodes.map((node) => [node.id, 0]));
    for (const link of data.links) {
      degree.set(idOf(link.source), (degree.get(idOf(link.source)) ?? 0) + 1);
      degree.set(idOf(link.target), (degree.get(idOf(link.target)) ?? 0) + 1);
    }
    return new Set([...degree.entries()].sort((left, right) => right[1] - left[1]).slice(0, 9).map(([id]) => id));
  }, [data.links, data.nodes]);

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
    const link = graph?.d3Force("link") as { distance?: (value: (edge: GraphLink) => number) => unknown; strength?: (value: (edge: GraphLink) => number) => unknown } | undefined;
    charge?.strength?.(-105);
    link?.distance?.((edge) => edge.type === "semantic_similarity" ? 72 : edge.type === "work_sequence" ? 96 : 84);
    link?.strength?.((edge) => edge.type === "semantic_similarity" ? .17 : edge.type === "work_sequence" ? .08 : .22);
    graph?.d3ReheatSimulation();
    window.setTimeout(() => graph?.zoomToFit(500, size.width < 600 ? 42 : 86), 350);
  }, [data.nodes.length, size.width]);

  useEffect(() => {
    if (!selectedId) return;
    const node = data.nodes.find((item) => item.id === selectedId);
    if (node?.x === undefined || node.y === undefined) return;
    graphRef.current?.centerAt(node.x, node.y, 450);
    graphRef.current?.zoom(Math.max(graphRef.current.zoom(), .95), 450);
  }, [data.nodes, selectedId]);

  return <div className="graph-wrap" ref={wrapRef}>
    <FacetField />
    <div className="visually-hidden" aria-label="Knowledge graph nodes">
      {data.nodes.map((node) => <button key={node.id} onClick={() => onSelect(node)}>{node.label}</button>)}
    </div>
    {data.nodes.length ? <ForceGraph2D ref={graphRef} width={size.width} height={size.height} graphData={data}
      backgroundColor="rgba(0,0,0,0)" d3AlphaDecay={0.035} d3VelocityDecay={0.25} cooldownTicks={110}
      onEngineStop={() => graphRef.current?.zoomToFit(450, size.width < 600 ? 42 : 82)}
      nodeLabel={(node) => `${node.label}\n${node.concepts.join(" · ")}`}
      linkColor={(link) => edgeColor(link, selectedId)}
      linkWidth={(link) => selectedId && (idOf(link.source) === selectedId || idOf(link.target) === selectedId) ? 1.35 : link.type === "semantic_similarity" ? .65 : .85}
      linkLineDash={(link) => link.type === "semantic_similarity" ? [5, 6] : null}
      linkDirectionalArrowLength={(link) => link.type === "explicit_reference" ? 4 : 0}
      linkDirectionalArrowRelPos={.78}
      nodeCanvasObjectMode={() => "replace"}
      nodePointerAreaPaint={(node, color, context) => drawPolygon(context, node.x ?? 0, node.y ?? 0, 9, 6, color)}
      nodeCanvasObject={(node, context, scale) => drawNode(node, context, scale, node.id === selectedId, neighbors.has(node.id), node.id === hoveredId, size.width < 600, labeledIds.has(node.id))}
      onNodeHover={(node) => setHoveredId(node?.id ?? null)}
      onNodeClick={(node) => onSelect(node)} onBackgroundClick={() => onSelect(null)}
    /> : <div className="empty-state"><div className="empty-mark" /><h1>Your network begins with one note.</h1><p>Import text, a screenshot, or an audio recording. The source stays local and traceable.</p></div>}
    <div className="edge-legend" aria-label="Relationship legend"><span><i className="solid-edge" />Provenance</span><span><i className="semantic-edge" />Semantic</span></div>
    <div className="zoom-controls">
      <button onClick={() => graphRef.current?.zoom((graphRef.current.zoom() ?? 1) * 1.35, 250)} aria-label="Zoom in"><Plus /></button>
      <button onClick={() => graphRef.current?.zoom((graphRef.current.zoom() ?? 1) / 1.35, 250)} aria-label="Zoom out"><Minus /></button>
      <button onClick={() => graphRef.current?.zoomToFit(400, 70)} aria-label="Fit graph"><Maximize /></button>
    </div>
  </div>;
});

function edgeColor(link: GraphLink, selectedId: string | null): string {
  if (selectedId && (idOf(link.source) === selectedId || idOf(link.target) === selectedId)) return link.type === "semantic_similarity" ? "rgba(155,131,240,.92)" : "rgba(155,218,239,.9)";
  if (link.type === "semantic_similarity") return "rgba(155,131,240,.42)";
  if (link.type === "explicit_reference") return "rgba(233,185,95,.55)";
  return "rgba(133,151,168,.42)";
}

function drawNode(node: GraphNode, context: CanvasRenderingContext2D, scale: number, selected: boolean, neighbor: boolean, hovered: boolean, compact: boolean, labeled: boolean) {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const active = selected || neighbor || hovered;
  const color = COLORS[node.sourceKind] ?? COLORS.text ?? "#62d7f5";
  const radius = (selected ? 14 : active ? 9 : 7) / scale;
  if (selected || hovered) {
    context.save();
    context.globalAlpha = selected ? .22 : .13;
    drawPolygon(context, x, y, radius * 3, 8, color);
    context.restore();
  }
  drawPolygon(context, x, y, radius, 6, color);
  context.strokeStyle = selected ? "#dff9ff" : "rgba(225,244,250,.72)";
  context.lineWidth = (selected ? 1.2 : .6) / scale;
  context.stroke();
  context.beginPath(); context.moveTo(x, y - radius); context.lineTo(x, y + radius); context.moveTo(x - radius * .86, y + radius * .5); context.lineTo(x + radius * .86, y - radius * .5);
  context.strokeStyle = `${color}88`; context.lineWidth = .55 / scale; context.stroke();
  if (selected) {
    context.strokeStyle = color; context.lineWidth = 1 / scale;
    for (let index = 0; index < 4; index += 1) {
      context.save(); context.translate(x, y); context.rotate(index * Math.PI / 2);
      context.beginPath(); context.moveTo(-radius * 1.45, -radius * 1.75); context.lineTo(-radius * 1.9, -radius * 1.75); context.lineTo(-radius * 1.9, -radius * 1.3); context.stroke(); context.restore();
    }
  }
  if (selected || hovered || (!compact && (labeled || scale > 1.2))) {
    const fontSize = (selected ? 12.5 : 11) / scale;
    context.font = `${selected ? 600 : 420} ${fontSize}px Inter, sans-serif`;
    context.textAlign = "center"; context.textBaseline = "top";
    context.fillStyle = selected ? "#e8f9ff" : "rgba(215,227,235,.84)";
    const label = node.label.length > 42 ? `${node.label.slice(0, 40)}…` : node.label;
    context.fillText(label, x, y + radius + (6 / scale));
  }
}

function drawPolygon(context: CanvasRenderingContext2D, x: number, y: number, radius: number, sides: number, fill: string) {
  context.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = -Math.PI / 2 + index * Math.PI * 2 / sides;
    const px = x + Math.cos(angle) * radius;
    const py = y + Math.sin(angle) * radius;
    if (index === 0) context.moveTo(px, py); else context.lineTo(px, py);
  }
  context.closePath(); context.fillStyle = fill; context.fill();
}

function FacetField() {
  return <svg className="facet-field" viewBox="0 0 1200 800" preserveAspectRatio="none" aria-hidden="true">
    <g>{[[0,0,180,0,92,135],[180,0,360,0,284,124],[360,0,555,0,470,160],[555,0,760,0,685,112],[760,0,980,0,870,156],[980,0,1200,0,1085,138],[0,0,92,135,0,292],[92,135,284,124,185,300],[284,124,470,160,376,330],[470,160,685,112,590,315],[685,112,870,156,780,335],[870,156,1085,138,974,318],[1085,138,1200,0,1200,290],[0,292,185,300,85,480],[185,300,376,330,278,520],[376,330,590,315,484,540],[590,315,780,335,685,535],[780,335,974,318,884,520],[974,318,1200,290,1090,505],[0,292,85,480,0,800],[85,480,278,520,190,800],[278,520,484,540,390,800],[484,540,685,535,595,800],[685,535,884,520,790,800],[884,520,1090,505,1000,800],[1090,505,1200,290,1200,800]].map((points, index) => <polygon key={index} points={points.join(" ")} />)}</g>
  </svg>;
}
