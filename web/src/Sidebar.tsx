import { LibraryBig, Network, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useState } from "react";

export type View = "network" | "sources";

export function Sidebar({ view, onChange }: { view: View; onChange: (view: View) => void }) {
  const [collapsed, setCollapsed] = useState(false);
  return <aside className={`sidebar ${collapsed ? "collapsed" : ""}`} aria-label="Primary navigation">
    <div className="brand">
      <div className="brand-lockup" aria-label="Digital Knowledge Network">
        <span className="brand-mark" aria-hidden="true"><span>DKN</span></span>
        <span className="brand-name">Digital Knowledge Network</span>
      </div>
      <button className="sidebar-toggle" onClick={() => setCollapsed((value) => !value)} aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} title={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
      </button>
    </div>
    <nav className="nav-list">
      <NavButton active={view === "network"} icon={<Network />} label="Network" onClick={() => onChange("network")} />
      <NavButton active={view === "sources"} icon={<LibraryBig />} label="Sources" onClick={() => onChange("sources")} />
    </nav>
  </aside>;
}

function NavButton({ active = false, icon, label, onClick }: { active?: boolean; icon: React.ReactElement; label: string; onClick: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} onClick={onClick} aria-current={active ? "page" : undefined}>
    {icon}<span>{label}</span>
  </button>;
}
