import { RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { GraphSettings } from "./types";

const DEFAULTS: GraphSettings = { noteNeighborCap: 4, noteSimilarityThreshold: .55, maxThemesPerWork: 8, minNotesPerTheme: 2, maxThemeShare: .3, themeMatchCap: 3, workNeighborCap: 4, workSimilarityThreshold: .55 };
const FIELDS: { key: keyof GraphSettings; label: string; detail: string; min: number; max: number; step: number; percent?: boolean }[] = [
  { key: "noteNeighborCap", label: "Connections per note", detail: "Maximum semantic neighbors. Lower values keep the graph legible.", min: 1, max: 12, step: 1 },
  { key: "noteSimilarityThreshold", label: "Note similarity floor", detail: "How similar two atomic notes must be before an edge appears.", min: .2, max: .95, step: .01, percent: true },
  { key: "maxThemesPerWork", label: "Theme cap", detail: "Maximum emergent theme cells created inside one work.", min: 1, max: 20, step: 1 },
  { key: "minNotesPerTheme", label: "Minimum theme size", detail: "Prevents tiny one-off clusters when enough notes exist.", min: 1, max: 12, step: 1 },
  { key: "maxThemeShare", label: "Largest theme share", detail: "Stops one broad theme from swallowing most of a source.", min: .15, max: .8, step: .01, percent: true },
  { key: "themeMatchCap", label: "Evidence themes", detail: "Distinct theme matches used to compare two works.", min: 1, max: 8, step: 1 },
  { key: "workNeighborCap", label: "Connections per work", detail: "Maximum neighbors for each top-level knowledge cell.", min: 1, max: 12, step: 1 },
  { key: "workSimilarityThreshold", label: "Work similarity floor", detail: "Minimum cross-work thematic similarity.", min: .2, max: .95, step: .01, percent: true },
];

export function SettingsPanel({ settings, saving, onApply, onClose }: { settings: GraphSettings; saving: boolean; onApply: (settings: GraphSettings) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  return <aside className="settings-panel" aria-label="Graph settings"><div className="settings-heading"><div><p className="eyebrow">SEMANTIC SYSTEM</p><h1>Graph parameters</h1></div><button className="icon-button" onClick={onClose} aria-label="Close settings"><X /></button></div>
    <p className="settings-intro">These controls rebuild derived relationships only. Your notes, source text, embeddings, and summaries remain untouched.</p>
    <div className="setting-fields">{FIELDS.map((field) => <label className="setting-field" key={field.key}><span><strong>{field.label}</strong><output>{field.percent ? `${Math.round(draft[field.key] * 100)}%` : draft[field.key]}</output></span><small>{field.detail}</small><input type="range" min={field.min} max={field.max} step={field.step} value={draft[field.key]} onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })} /></label>)}</div>
    <div className="settings-actions"><button className="reset-button" onClick={() => setDraft(DEFAULTS)} disabled={saving}><RotateCcw />Defaults</button><button className="apply-button" onClick={() => void onApply(draft)} disabled={saving}>{saving ? "Regenerating…" : "Apply & regenerate"}</button></div>
  </aside>;
}
