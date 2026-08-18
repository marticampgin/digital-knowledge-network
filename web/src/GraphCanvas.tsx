import { Maximize, Minus, Plus } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { GraphLink, GraphNode, ThemeCell } from "./types";

type ThemeNode = { id: string; label: string; nodeType: "theme"; noteCount: number; x?: number; y?: number };
type CanvasNode = (GraphNode & { nodeType: "note" }) | ThemeNode;
type CanvasLink = { source: string | CanvasNode; target: string | CanvasNode; type: "semantic_similarity" | "theme_membership"; weight: number; evidence: string };
const idOf = (value: string | CanvasNode) => typeof value === "string" ? value : value.id;

export const GraphCanvas = memo(function GraphCanvas({ nodes, links, themes, selectedId, onSelect }: {
  nodes: GraphNode[]; links: GraphLink[]; themes: ThemeCell[]; selectedId: string | null; onSelect: (node: GraphNode | null) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<CanvasNode, CanvasLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 900, height: 700 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const data = useMemo(() => {
    const noteNodes: CanvasNode[] = nodes.map((node) => ({ ...node, nodeType: "note" }));
    const themeNodes: CanvasNode[] = themes.map((theme) => ({ id: theme.id, label: theme.label, nodeType: "theme", noteCount: theme.noteCount }));
    const semantic: CanvasLink[] = links.filter((link) => link.type === "semantic_similarity").map((link) => ({ source: typeof link.source === "string" ? link.source : link.source.id, target: typeof link.target === "string" ? link.target : link.target.id, type: "semantic_similarity", weight: link.weight, evidence: link.evidence }));
    const membership: CanvasLink[] = themes.flatMap((theme) => theme.noteIds.map((noteId) => ({ source: theme.id, target: noteId, type: "theme_membership" as const, weight: 1, evidence: theme.label })));
    return { nodes: [...noteNodes, ...themeNodes], links: [...semantic, ...membership] };
  }, [links, nodes, themes]);
  const neighbors = useMemo(() => {
    const ids = new Set<string>();
    if (!selectedId) return ids;
    for (const link of data.links) {
      if (link.type !== "semantic_similarity") continue;
      if (idOf(link.source) === selectedId) ids.add(idOf(link.target));
      if (idOf(link.target) === selectedId) ids.add(idOf(link.source));
    }
    return ids;
  }, [data.links, selectedId]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const observer = new ResizeObserver(([entry]) => entry && setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) }));
    observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!data.nodes.length) return;
    const graph = graphRef.current;
    const charge = graph?.d3Force("charge") as { strength?: (value: number) => unknown } | undefined;
    const link = graph?.d3Force("link") as { distance?: (value: (edge: CanvasLink) => number) => unknown; strength?: (value: (edge: CanvasLink) => number) => unknown } | undefined;
    charge?.strength?.(-125);
    link?.distance?.((edge) => edge.type === "theme_membership" ? 105 : 68);
    link?.strength?.((edge) => edge.type === "theme_membership" ? .12 : .34);
    graph?.d3ReheatSimulation();
    window.setTimeout(() => graph?.zoomToFit(500, size.width < 600 ? 42 : 86), 300);
  }, [data, size.width]);

  return <div className="graph-wrap" ref={wrapRef}>
    <FacetField />
    <div className="visually-hidden" aria-label="Knowledge graph notes">{nodes.map((node) => <button key={node.id} onClick={() => onSelect(node)}>{node.label}</button>)}</div>
    {nodes.length ? <ForceGraph2D ref={graphRef} width={size.width} height={size.height} graphData={data}
      backgroundColor="rgba(0,0,0,0)" d3AlphaDecay={.035} d3VelocityDecay={.25} cooldownTicks={130}
      nodeLabel={(node) => node.nodeType === "theme" ? `${node.label} · ${node.noteCount} notes` : `${node.label}\n${node.concepts.join(" · ")}`}
      linkVisibility={(link) => link.type === "semantic_similarity"}
      linkColor={(link) => selectedId && (idOf(link.source) === selectedId || idOf(link.target) === selectedId) ? "rgba(155,131,240,.9)" : "rgba(155,131,240,.36)"}
      linkWidth={(link) => link.type === "semantic_similarity" ? .7 : 0} linkLineDash={() => [5, 6]}
      nodeCanvasObjectMode={() => "replace"}
      nodePointerAreaPaint={(node, color, context) => drawPolygon(context, node.x ?? 0, node.y ?? 0, node.nodeType === "theme" ? 16 : 9, node.nodeType === "theme" ? 5 : 6, color)}
      nodeCanvasObject={(node, context, scale) => node.nodeType === "theme" ? drawTheme(node, context, scale) : drawNote(node, context, scale, node.id === selectedId, neighbors.has(node.id), node.id === hoveredId, size.width < 600)}
      onNodeHover={(node) => setHoveredId(node?.id ?? null)}
      onNodeClick={(node) => node.nodeType === "note" && onSelect(byId.get(node.id) ?? null)} onBackgroundClick={() => onSelect(null)}
    /> : <div className="empty-state"><div className="empty-mark" /><h1>This work has no processed notes yet.</h1><p>Process its captures to reveal its semantic structure.</p></div>}
    <div className="edge-legend"><span><i className="semantic-edge" />Semantic similarity</span><span><b className="theme-gem" />Emergent theme</span></div>
    <ZoomControls graph={graphRef} />
  </div>;
});

function ZoomControls({ graph }: { graph: RefObject<ForceGraphMethods<CanvasNode, CanvasLink> | undefined> }) {
  return <div className="zoom-controls"><button onClick={() => graph.current?.zoom((graph.current.zoom() ?? 1) * 1.35, 250)} aria-label="Zoom in"><Plus /></button><button onClick={() => graph.current?.zoom((graph.current.zoom() ?? 1) / 1.35, 250)} aria-label="Zoom out"><Minus /></button><button onClick={() => graph.current?.zoomToFit(400, 70)} aria-label="Fit graph"><Maximize /></button></div>;
}

function drawTheme(node: ThemeNode, context: CanvasRenderingContext2D, scale: number) {
  const x = node.x ?? 0, y = node.y ?? 0, radius = (18 + Math.min(node.noteCount, 12)) / scale;
  context.save(); context.globalAlpha = .12; drawPolygon(context, x, y, radius * 1.55, 5, "#9b83f0"); context.restore();
  drawPolygon(context, x, y, radius, 5, "rgba(15,22,38,.92)"); context.strokeStyle = "rgba(155,131,240,.82)"; context.lineWidth = 1.2 / scale; context.stroke();
  context.font = `600 ${11 / scale}px Inter, sans-serif`; context.textAlign = "center"; context.textBaseline = "top"; context.fillStyle = "rgba(220,211,255,.9)";
  context.fillText(node.label.length > 34 ? `${node.label.slice(0, 32)}…` : node.label, x, y + radius + 7 / scale);
}

function drawNote(node: GraphNode, context: CanvasRenderingContext2D, scale: number, selected: boolean, neighbor: boolean, hovered: boolean, compact: boolean) {
  const x = node.x ?? 0, y = node.y ?? 0, active = selected || neighbor || hovered, radius = (selected ? 14 : active ? 9 : 7) / scale, color = "#62d7f5";
  if (selected || hovered) { context.save(); context.globalAlpha = selected ? .22 : .13; drawPolygon(context, x, y, radius * 3, 8, color); context.restore(); }
  drawPolygon(context, x, y, radius, 6, color); context.strokeStyle = selected ? "#dff9ff" : "rgba(225,244,250,.72)"; context.lineWidth = (selected ? 1.2 : .6) / scale; context.stroke();
  if (selected || hovered || (!compact && scale > 1.25)) { context.font = `${selected ? 600 : 420} ${(selected ? 12.5 : 11) / scale}px Inter, sans-serif`; context.textAlign = "center"; context.textBaseline = "top"; context.fillStyle = selected ? "#e8f9ff" : "rgba(215,227,235,.84)"; context.fillText(node.label.length > 42 ? `${node.label.slice(0, 40)}…` : node.label, x, y + radius + 6 / scale); }
}

function drawPolygon(context: CanvasRenderingContext2D, x: number, y: number, radius: number, sides: number, fill: string) { context.beginPath(); for (let index = 0; index < sides; index += 1) { const angle = -Math.PI / 2 + index * Math.PI * 2 / sides; const px = x + Math.cos(angle) * radius, py = y + Math.sin(angle) * radius; index ? context.lineTo(px, py) : context.moveTo(px, py); } context.closePath(); context.fillStyle = fill; context.fill(); }

function FacetField() { return <svg className="facet-field" viewBox="0 0 1200 800" preserveAspectRatio="none" aria-hidden="true"><g>{[[0,0,180,0,92,135],[180,0,360,0,284,124],[360,0,555,0,470,160],[555,0,760,0,685,112],[760,0,980,0,870,156],[980,0,1200,0,1085,138],[0,0,92,135,0,292],[92,135,284,124,185,300],[284,124,470,160,376,330],[470,160,685,112,590,315],[685,112,870,156,780,335],[870,156,1085,138,974,318],[0,292,185,300,85,480],[185,300,376,330,278,520],[376,330,590,315,484,540],[590,315,780,335,685,535],[780,335,974,318,884,520],[974,318,1200,290,1090,505]].map((points, index) => <polygon key={index} points={points.join(" ")} />)}</g></svg>; }
