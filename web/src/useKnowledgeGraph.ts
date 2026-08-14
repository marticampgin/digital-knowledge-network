import { useCallback, useEffect, useState, useTransition } from "react";
import type { GraphData } from "./types";

const EMPTY_GRAPH: GraphData = { nodes: [], links: [] };

export function useKnowledgeGraph() {
  const [graph, setGraph] = useState<GraphData>(EMPTY_GRAPH);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/graph");
      if (!response.ok) throw new Error(`Graph request failed: ${response.status}`);
      const data = await response.json() as GraphData;
      startTransition(() => setGraph(data));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  return { graph, error, isPending, refresh };
}

