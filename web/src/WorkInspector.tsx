import { ArrowRight, Network, X } from "lucide-react";
import type { ThemeCell, WorkCell, WorkRelationship } from "./types";

export function WorkInspector({ work, themes, links, works, onExplore, onClose }: { work: WorkCell; themes: ThemeCell[]; links: WorkRelationship[]; works: WorkCell[]; onExplore: () => void; onClose: () => void }) {
  const names = new Map(works.map((item) => [item.id, item.title]));
  const related = links.filter((link) => link.source === work.id || link.target === work.id);
  return <aside className="inspector work-inspector" aria-label="Selected work"><button className="icon-button inspector-close" onClick={onClose} aria-label="Close inspector"><X /></button>
    <p className="eyebrow">KNOWLEDGE CELL</p><h1>{work.title}</h1>{work.author ? <p className="work-author">{work.author}</p> : null}
    <div className="work-metrics"><span><strong>{work.noteCount}</strong> atomic notes</span><span><strong>{work.themeCount}</strong> themes</span></div>
    <section><h2>EMERGENT THEMES</h2><div className="concept-list">{themes.map((theme) => <span className="concept-chip" key={theme.id}>{theme.label} · {theme.noteCount}</span>)}</div></section>
    <section><h2>EVOLVING SUMMARY</h2><p className="work-summary">{work.summary ?? "Generate a work summary to turn this source into a readable knowledge cell."}</p></section>
    <section><h2>RELATED WORKS</h2>{related.length ? related.map((link) => { const other = link.source === work.id ? link.target : link.source; return <div className="connection-row" key={other}><span className="connection-gem kind-text" /><span>{names.get(other)}</span><small>{Math.round(link.weight * 100)}%</small></div>; }) : <p className="empty-copy">Connections will emerge as more works are added.</p>}</section>
    <div className="inspector-actions"><button onClick={onExplore}><Network />Explore atomic notes<ArrowRight /></button></div>
  </aside>;
}
