import type { Enricher } from "./enrichment.js";
import { PROMPT_VERSION } from "./enrichment.js";
import { KnowledgeStore } from "./store.js";

export interface ProcessResult {
  processed: number;
  failed: number;
  edges: number;
  errors: Array<{ noteId: string; message: string }>;
}

export async function processPending(store: KnowledgeStore, enricher: Enricher, limit = 100): Promise<ProcessResult> {
  let processed = 0;
  let failed = 0;
  const errors: ProcessResult["errors"] = [];
  for (const note of store.pendingNotes(limit)) {
    try {
      store.enrichNote(note.id, await enricher.enrich(note, store.enrichmentContext(note.id)), enricher.name, PROMPT_VERSION);
      processed += 1;
    } catch (error) {
      store.failNote(note.id);
      failed += 1;
      errors.push({ noteId: note.id, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { processed, failed, edges: store.replaceDerivedEdges(), errors };
}
