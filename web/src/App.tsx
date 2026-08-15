import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { GraphCanvas } from "./GraphCanvas";
import { Inspector } from "./Inspector";
import { Sidebar, type View } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import type { GraphNode } from "./types";
import { useKnowledgeGraph } from "./useKnowledgeGraph";

export default function App() {
  const { graph, error, isPending, refresh } = useKnowledgeGraph();
  const [view, setView] = useState<View>("network");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [source, setSource] = useState("all");
  const [relation, setRelation] = useState("all");
  const [importing, setImporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 3000);
    return () => window.clearTimeout(timer);
  }, [message]);

  const filtered = useMemo(() => {
    const nodes = graph.nodes.filter((node) => {
      const sourceMatch = source === "all" || source === "book" && ["text", "markdown", "telegram"].includes(node.sourceKind) || node.sourceKind === source;
      const textMatch = !deferredSearch || `${node.label} ${node.tags.join(" ")} ${node.concepts.join(" ")} ${node.sourceTitle}`.toLowerCase().includes(deferredSearch);
      return sourceMatch && textMatch;
    });
    const ids = new Set(nodes.map((node) => node.id));
    const links = graph.links.filter((link) => ids.has(nodeId(link.source)) && ids.has(nodeId(link.target)) && (relation === "all" || link.type === relation));
    return { nodes, links };
  }, [graph, deferredSearch, source, relation]);
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;

  async function importFile(file: File) {
    setImporting(true); setMessage(null);
    try {
      const body = new FormData(); body.append("file", file);
      const response = await fetch("/api/import", { method: "POST", body });
      const result = await response.json() as { error?: string; notes?: number; duplicate?: boolean };
      if (!response.ok) throw new Error(result.error ?? `Import failed: ${response.status}`);
      setMessage(result.duplicate ? "Already in your network" : `${result.notes ?? 0} note${result.notes === 1 ? "" : "s"} added`);
      await refresh();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : String(caught));
    } finally { setImporting(false); }
  }

  return <main className="app-shell">
    <Sidebar view={view} onChange={setView} />
    <section className="workspace">
      <Toolbar search={search} onSearch={setSearch} source={source} relation={relation} onSource={setSource} onRelation={setRelation} onImport={(file) => void importFile(file)} busy={importing} />
      {view === "network" ? <GraphCanvas data={filtered} selectedId={selectedId} onSelect={(node) => setSelectedId(node?.id ?? null)} /> : <ListView view={view} nodes={graph.nodes} onSelect={(node) => setSelectedId(node.id)} />}
      <div className={`local-status view-${view}`}><i />Local · {graph.nodes.length} {graph.nodes.length === 1 ? "note" : "notes"}{isPending ? " · updating" : ""}</div>
      {(message || error) ? <div className="toast" role="status">{message ?? error}</div> : null}
    </section>
    {selected ? <Inspector node={selected} nodes={graph.nodes} links={graph.links} mode={view} onClose={() => setSelectedId(null)} onCopySource={() => {
      void navigator.clipboard.writeText(selected.sourceText)
        .then(() => setMessage("Source text copied to the clipboard"))
        .catch(() => setMessage("Could not copy source text"));
    }} /> : null}
  </main>;
}

function nodeId(value: string | GraphNode) { return typeof value === "string" ? value : value.id; }

function ListView({ nodes, onSelect }: { view: Exclude<View, "network">; nodes: GraphNode[]; onSelect: (node: GraphNode) => void }) {
  return <div className="list-view"><h1>Sources</h1><p>Every idea remains connected to where it came from.</p>
    <div className="note-list">{nodes.map((node) => <button key={node.id} onClick={() => onSelect(node)}><span className={`connection-gem kind-${node.sourceKind}`} /><span className="note-summary"><strong>{node.label}</strong><span className="concept-list compact">{node.concepts.map((concept) => <span className="concept-chip" key={concept}>{concept}</span>)}</span></span><small>{node.sourceTitle}</small></button>)}</div>
  </div>;
}
