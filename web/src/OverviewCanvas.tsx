import { Maximize, Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import type { WorkCell, WorkRelationship } from "./types";

type WorkNode = WorkCell & { x?: number; y?: number };
type WorkLink = Omit<WorkRelationship, "source" | "target"> & { source: string | WorkNode; target: string | WorkNode };

export function OverviewCanvas({ works, links, selectedId, onSelect }: { works: WorkCell[]; links: WorkRelationship[]; selectedId: string | null; onSelect: (work: WorkCell | null) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<WorkNode, WorkLink> | undefined>(undefined);
  const [size, setSize] = useState({ width: 900, height: 700 });
  useEffect(() => { if (!wrapRef.current) return; const observer = new ResizeObserver(([entry]) => entry && setSize({ width: entry.contentRect.width, height: entry.contentRect.height })); observer.observe(wrapRef.current); return () => observer.disconnect(); }, []);
  useEffect(() => { const graph = graphRef.current; const charge = graph?.d3Force("charge") as { strength?: (value: number) => unknown } | undefined; charge?.strength?.(-420); graph?.d3ReheatSimulation(); window.setTimeout(() => graph?.zoomToFit(450, 110), 250); }, [works, links]);
  return <div className="graph-wrap overview-wrap" ref={wrapRef}>
    {works.length ? <ForceGraph2D ref={graphRef} width={size.width} height={size.height} graphData={{ nodes: works, links }} backgroundColor="rgba(0,0,0,0)"
      nodeLabel={(node) => `${node.title}\n${node.noteCount} notes · ${node.themeCount} themes`}
      linkLabel={(link) => `${Math.round(link.weight * 100)}% thematic similarity`} linkColor={() => "rgba(155,131,240,.55)"} linkWidth={(link) => 1 + link.weight * 2}
      nodeCanvasObjectMode={() => "replace"} nodePointerAreaPaint={(node, color, context) => polygon(context, node.x ?? 0, node.y ?? 0, 30, color)}
      nodeCanvasObject={(node, context, scale) => drawWork(node, context, scale, node.id === selectedId)} onNodeClick={onSelect} onBackgroundClick={() => onSelect(null)}
      onEngineStop={() => graphRef.current?.zoomToFit(450, 110)}
    /> : <div className="empty-state"><div className="empty-mark" /><h1>Your knowledge landscape is empty.</h1><p>Add a source and process its first atomic note.</p></div>}
    <div className="overview-caption"><strong>Knowledge landscape</strong><span>Works connect through their strongest distinct themes—not through source size.</span></div>
    <div className="zoom-controls"><button onClick={() => graphRef.current?.zoom((graphRef.current.zoom() ?? 1) * 1.35, 250)} aria-label="Zoom in"><Plus /></button><button onClick={() => graphRef.current?.zoom((graphRef.current.zoom() ?? 1) / 1.35, 250)} aria-label="Zoom out"><Minus /></button><button onClick={() => graphRef.current?.zoomToFit(400, 100)} aria-label="Fit graph"><Maximize /></button></div>
  </div>;
}

function drawWork(node: WorkNode, context: CanvasRenderingContext2D, scale: number, selected: boolean) {
  const x = node.x ?? 0, y = node.y ?? 0, radius = (30 + Math.min(node.themeCount, 10) * 1.8) / scale;
  if (selected) { context.save(); context.globalAlpha = .13; polygon(context, x, y, radius * 1.65, "#62d7f5"); context.restore(); }
  polygon(context, x, y, radius, "rgba(10,25,34,.96)"); context.strokeStyle = selected ? "#dff9ff" : "rgba(98,215,245,.84)"; context.lineWidth = (selected ? 2 : 1.2) / scale; context.stroke();
  context.font = `600 ${13 / scale}px Inter, sans-serif`; context.textAlign = "center"; context.textBaseline = "top"; context.fillStyle = "#e5f7fb"; context.fillText(shorten(node.title, 44), x, y + radius + 9 / scale);
  context.font = `500 ${10 / scale}px Inter, sans-serif`; context.fillStyle = "rgba(150,170,182,.88)"; context.fillText(`${node.noteCount} notes · ${node.themeCount} themes`, x, y + radius + 27 / scale);
}
function shorten(value: string, cap: number) { return value.length > cap ? `${value.slice(0, cap - 1)}…` : value; }
function polygon(context: CanvasRenderingContext2D, x: number, y: number, radius: number, fill: string) { context.beginPath(); for (let i = 0; i < 6; i += 1) { const a = -Math.PI / 2 + i * Math.PI / 3, px = x + Math.cos(a) * radius, py = y + Math.sin(a) * radius; i ? context.lineTo(px, py) : context.moveTo(px, py); } context.closePath(); context.fillStyle = fill; context.fill(); }
