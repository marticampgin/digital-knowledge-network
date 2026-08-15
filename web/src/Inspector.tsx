import { BookOpen, Copy, Sparkles, X } from "lucide-react";
import type { View } from "./Sidebar";
import type { GraphLink, GraphNode } from "./types";

const nodeId = (value: string | GraphNode) => typeof value === "string" ? value : value.id;

export function Inspector({ node, links, nodes, mode, onClose, onCopySource }: { node: GraphNode; links: GraphLink[]; nodes: GraphNode[]; mode: View; onClose: () => void; onCopySource: () => void }) {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const connections = links.filter((link) => nodeId(link.source) === node.id || nodeId(link.target) === node.id).slice(0, 8).map((link) => ({
    link,
    node: byId.get(nodeId(link.source) === node.id ? nodeId(link.target) : nodeId(link.source)),
  }));
  const generatedSections = <>
    <section>
      <h2><Sparkles />CORE IDEA <small>LLM GENERATED</small></h2>
      <p className="core-idea">{node.coreIdea || "This note is waiting to be enriched."}</p>
    </section>
    <section>
      <h2>CONCEPTS <small>CONTROLLED VOCABULARY</small></h2>
      <div className="concept-list">{node.concepts.length ? node.concepts.map((concept) => <span className="concept-chip" key={concept}>{concept}</span>) : <p className="empty-copy">Concepts will appear after the knowledge layer runs.</p>}</div>
      {node.tags.length ? <div className="tag-list" aria-label="Descriptive tags">{node.tags.map((tag) => <span className="tag-chip" key={tag}>{tag}</span>)}</div> : null}
    </section>
    {node.context ? <section><h2>CONTEXT <small>LLM GENERATED</small></h2><p>{node.context}</p></section> : null}
  </>;
  const sourceSections = <>
    <section>
      <h2>SOURCE</h2>
      <div className="source-row"><BookOpen /><span>{node.sourceTitle}</span></div>
    </section>
    <section>
      <h2>{node.sourceKind === "image" ? "CANONICAL OCR TEXT" : node.sourceKind === "audio" ? "CANONICAL TRANSCRIPT" : "CANONICAL SOURCE TEXT"}</h2>
      <pre className="source-evidence">{node.sourceText}</pre>
    </section>
  </>;
  return <aside className="inspector" aria-label="Selected note">
    <div className="sheet-handle" aria-hidden="true" />
    <button className="icon-button inspector-close" onClick={onClose} aria-label="Close inspector"><X /></button>
    <h1>Atomic note</h1>
    {mode === "sources" ? <>{sourceSections}{generatedSections}</> : <>{generatedSections}{sourceSections}</>}
    <section className="connections">
      <h2>CONNECTIONS</h2>
      {connections.length ? connections.map(({ link, node: related }) => <div className="connection-row" key={`${nodeId(link.source)}-${nodeId(link.target)}-${link.type}`} title={link.evidence}>
        <span className={`connection-gem kind-${related?.sourceKind ?? "text"}`} />
        <span>{related?.label ?? "Related note"}</span>
        <small>{relationshipLabel(link)}</small>
      </div>) : <p className="empty-copy">Connections appear after more notes are processed.</p>}
    </section>
    <div className="inspector-actions">
      <button onClick={onCopySource}><Copy />Copy source text</button>
    </div>
  </aside>;
}

function relationshipLabel(link: GraphLink): string {
  if (link.type === "work_sequence") return "Next in work";
  if (link.type === "source_sequence" || link.type === "capture_sequence") return "Sequence";
  if (link.type === "explicit_reference") return "Reply";
  return `Semantic · ${Math.round(link.weight * 100)}%`;
}
