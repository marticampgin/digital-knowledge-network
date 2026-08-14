import { ChevronDown, Search, Upload } from "lucide-react";
import { useRef } from "react";

export function Toolbar({ search, onSearch, source, relation, onSource, onRelation, onImport, busy }: {
  search: string; onSearch: (value: string) => void; source: string; relation: string;
  onSource: (value: string) => void; onRelation: (value: string) => void;
  onImport: (file: File) => void; busy: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return <header className="toolbar">
    <label className="search-control">
      <Search size={19} />
      <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search your knowledge" aria-label="Search your knowledge" />
      <kbd>⌘K</kbd>
    </label>
    <SelectControl label="Source filter" value={source} onChange={onSource} options={[["all", "All sources"], ["book", "Book & text"], ["image", "Capture"], ["audio", "Audio"]]} />
    <SelectControl label="Relation filter" value={relation} onChange={onRelation} options={[["all", "All relations"], ["source_sequence", "Source sequence"], ["shared_tag", "Shared tags"]]} />
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

