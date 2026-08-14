import { CircleHelp, Network, Settings, LibraryBig, Keyboard, ChevronsLeft } from "lucide-react";

export type View = "network" | "sources";

export function Sidebar({ view, onChange, onUtility }: { view: View; onChange: (view: View) => void; onUtility: (label: string) => void }) {
  return <aside className="sidebar" aria-label="Primary navigation">
    <div className="brand"><span>D / K / N</span><ChevronsLeft size={17} /></div>
    <nav className="nav-list">
      <NavButton active={view === "network"} icon={<Network />} label="Network" onClick={() => onChange("network")} />
      <NavButton active={view === "sources"} icon={<LibraryBig />} label="Sources" onClick={() => onChange("sources")} />
    </nav>
    <nav className="nav-list nav-secondary">
      <NavButton icon={<Settings />} label="Settings" onClick={() => onUtility("Settings are not available in this prototype yet.")} />
      <NavButton icon={<Keyboard />} label="Shortcuts" onClick={() => onUtility("Keyboard navigation is enabled; a shortcut reference is planned.")} />
      <NavButton icon={<CircleHelp />} label="Help" onClick={() => onUtility("Open README.md for setup and workflow instructions.")} />
    </nav>
  </aside>;
}

function NavButton({ active = false, icon, label, onClick }: { active?: boolean; icon: React.ReactElement; label: string; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
    {icon}<span>{label}</span>
  </button>;
}
