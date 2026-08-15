import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import type { GraphData } from "./types";

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

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
  return { graph, error, isPending, refresh };
}
