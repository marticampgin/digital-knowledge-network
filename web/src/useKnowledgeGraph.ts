import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { GraphData } from "./types";

const EMPTY_GRAPH: GraphData = { nodes: [], links: [], hierarchy: { version: "", settings: { noteNeighborCap: 4, noteSimilarityThreshold: .55, maxThemesPerWork: 8, minNotesPerTheme: 2, maxThemeShare: .3, themeMatchCap: 3, workNeighborCap: 4, workSimilarityThreshold: .55 }, works: [], themes: [], workLinks: [], noteThemes: {} } };

export function useKnowledgeGraph() {
  const [graph, setGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const signatureRef = useRef("");

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/graph", { cache: "no-store" });
      if (!response.ok) throw new Error(`Graph request failed: ${response.status}`);
      const data = await response.json() as GraphData;
      const signature = JSON.stringify(data);
      if (signature !== signatureRef.current) {
        signatureRef.current = signature;
        startTransition(() => setGraph(data));
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  const updateSettings = useCallback(async (settings: GraphData["hierarchy"]["settings"]) => {
    const response = await fetch("/api/graph/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    if (!response.ok) throw new Error(`Could not regenerate graph: ${response.status}`);
    await refresh();
  }, [refresh]);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 4_000);
    const refreshOnFocus = () => void refresh();
    window.addEventListener("focus", refreshOnFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
    };
  }, [refresh]);
  return { graph, error, isPending, refresh, updateSettings };
}
