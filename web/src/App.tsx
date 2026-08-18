import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { GraphCanvas } from "./GraphCanvas";
import { Inspector } from "./Inspector";
import { OverviewCanvas } from "./OverviewCanvas";
import { SettingsPanel } from "./SettingsPanel";
import { Sidebar, type View } from "./Sidebar";
import { Toolbar } from "./Toolbar";
import type { GraphNode } from "./types";
import { useKnowledgeGraph } from "./useKnowledgeGraph";
import { WorkInspector } from "./WorkInspector";

export default function App() {
  const { graph, error, isPending, refresh, updateSettings } = useKnowledgeGraph();
  const [view, setView] = useState<View>("network");
  const [scope, setScope] = useState("overview");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedWorkId, setSelectedWorkId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(null), 3000); return () => window.clearTimeout(timer); }, [message]);

  const activeWork = graph.hierarchy.works.find((work) => work.id === scope) ?? null;
  const filtered = useMemo(() => {
    const nodes = graph.nodes.filter((node) => (!activeWork || node.workId === activeWork.id) && (!deferredSearch || `${node.label} ${node.tags.join(" ")} ${node.concepts.join(" ")} ${node.sourceTitle}`.toLowerCase().includes(deferredSearch)));
    const ids = new Set(nodes.map((node) => node.id));
    return { nodes, links: graph.links.filter((link) => link.type === "semantic_similarity" && ids.has(nodeId(link.source)) && ids.has(nodeId(link.target))), themes: graph.hierarchy.themes.filter((theme) => !activeWork || theme.workId === activeWork.id).map((theme) => ({ ...theme, noteIds: theme.noteIds.filter((id) => ids.has(id)), noteCount: theme.noteIds.filter((id) => ids.has(id)).length })).filter((theme) => theme.noteCount) };
  }, [activeWork, deferredSearch, graph]);
  const selected = graph.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedWork = graph.hierarchy.works.find((work) => work.id === selectedWorkId) ?? null;

  function chooseScope(value: string) { setScope(value); setSelectedId(null); setSelectedWorkId(null); }
  async function importFile(file: File) {
    setImporting(true); setMessage(null);
    try { const body = new FormData(); body.append("file", file); const response = await fetch("/api/import", { method: "POST", body }); const result = await response.json() as { error?: string; notes?: number; duplicate?: boolean }; if (!response.ok) throw new Error(result.error ?? `Import failed: ${response.status}`); setMessage(result.duplicate ? "Already in your network" : `${result.notes ?? 0} note${result.notes === 1 ? "" : "s"} added`); await refresh(); }
    catch (caught) { setMessage(caught instanceof Error ? caught.message : String(caught)); } finally { setImporting(false); }
  }
  async function applySettings(settings: typeof graph.hierarchy.settings) { setSavingSettings(true); try { await updateSettings(settings); setMessage("Graph regenerated"); setSettingsOpen(false); } catch (caught) { setMessage(caught instanceof Error ? caught.message : String(caught)); } finally { setSavingSettings(false); } }

  return <main className="app-shell">
    <Sidebar view={view} onChange={setView} />
    <section className="workspace">
      <Toolbar search={search} onSearch={setSearch} scope={scope} works={graph.hierarchy.works} onScope={chooseScope} onSettings={() => setSettingsOpen(true)} onImport={(file) => void importFile(file)} busy={importing} />
      {view === "network" ? <>
        <div className="graph-breadcrumb"><button onClick={() => chooseScope("overview")}>Knowledge landscape</button>{activeWork ? <><span>/</span><strong>{activeWork.title}</strong></> : <small>WORK-LEVEL VIEW</small>}</div>
        {activeWork ? <GraphCanvas nodes={filtered.nodes} links={filtered.links} themes={filtered.themes} selectedId={selectedId} onSelect={(node) => setSelectedId(node?.id ?? null)} /> : <OverviewCanvas works={graph.hierarchy.works} links={graph.hierarchy.workLinks} selectedId={selectedWorkId} onSelect={(work) => setSelectedWorkId(work?.id ?? null)} />}
      </> : <ListView nodes={graph.nodes} onSelect={(node) => setSelectedId(node.id)} />}
      <div className={`local-status view-${view}`}><i />Local · {graph.nodes.length} {graph.nodes.length === 1 ? "note" : "notes"}{isPending ? " · updating" : ""}</div>
      {(message || error) ? <div className="toast" role="status">{message ?? error}</div> : null}
    </section>
    {selected ? <Inspector node={selected} nodes={graph.nodes} links={graph.links.filter((link) => link.type === "semantic_similarity")} mode={view} onClose={() => setSelectedId(null)} onCopySource={() => void navigator.clipboard.writeText(selected.sourceText).then(() => setMessage("Source text copied")).catch(() => setMessage("Could not copy source text"))} /> : null}
    {selectedWork ? <WorkInspector work={selectedWork} themes={graph.hierarchy.themes.filter((theme) => theme.workId === selectedWork.id)} links={graph.hierarchy.workLinks} works={graph.hierarchy.works} onClose={() => setSelectedWorkId(null)} onExplore={() => chooseScope(selectedWork.id)} /> : null}
    {settingsOpen ? <SettingsPanel settings={graph.hierarchy.settings} saving={savingSettings} onApply={applySettings} onClose={() => setSettingsOpen(false)} /> : null}
  </main>;
}

function nodeId(value: string | GraphNode) { return typeof value === "string" ? value : value.id; }
function ListView({ nodes, onSelect }: { nodes: GraphNode[]; onSelect: (node: GraphNode) => void }) { return <div className="list-view"><h1>Sources</h1><p>Every idea remains connected to where it came from.</p><div className="note-list">{nodes.map((node) => <button key={node.id} onClick={() => onSelect(node)}><span className="connection-gem kind-text" /><span className="note-summary"><strong>{node.label}</strong><span className="concept-list compact">{node.concepts.map((concept) => <span className="concept-chip" key={concept}>{concept}</span>)}</span></span><small>{node.sourceTitle}</small></button>)}</div></div>; }
