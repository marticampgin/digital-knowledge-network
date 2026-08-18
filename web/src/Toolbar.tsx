import { ChevronDown, Search, Settings2, Upload } from "lucide-react";
import { useRef } from "react";

export function Toolbar({ search, onSearch, scope, works, onScope, onSettings, onImport, busy }: {
  search: string; onSearch: (value: string) => void; scope: string; works: { id: string; title: string }[];
  onScope: (value: string) => void; onSettings: () => void; onImport: (file: File) => void; busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <header className="toolbar">
    <label className="search-control">
      <Search size={19} />
      <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search your knowledge" aria-label="Search your knowledge" />
      <kbd>/</kbd>
    </label>
    <SelectControl label="Knowledge scope" value={scope} onChange={onScope} options={[["overview", "Knowledge overview"], ...works.map((work) => [work.id, work.title])]} />
    <button className="mobile-filter settings-button" onClick={onSettings} aria-label="Graph settings"><Settings2 /></button>
    <button className="import-button" onClick={() => inputRef.current?.click()} disabled={busy}>
      <Upload size={18} />{busy ? "Importing…" : "Import"}
    </button>
    <input ref={inputRef} className="visually-hidden" type="file" accept=".txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff,.wav,.mp3,.ogg,.oga,.opus,.m4a,.aac,.flac" onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) onImport(file);
      event.target.value = "";
    }} />
  </header>;
}

function SelectControl({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[][] }) {
  return <label className="select-control">
    <span className="visually-hidden">{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}</select>
    <ChevronDown size={16} aria-hidden />
  </label>;
}
