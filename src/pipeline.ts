import type { Enricher } from "./enrichment.js";
import { PROMPT_VERSION } from "./enrichment.js";
import { KnowledgeStore } from "./store.js";

export interface ProcessResult {
  processed: number;
  failed: number;
  edges: number;
  errors: Array<{ noteId: string; message: string }>;
}

export type ProcessProgress =
  | { phase: "start"; total: number }
  | { phase: "note-start" | "heartbeat" | "note-complete" | "note-failed"; current: number; total: number; noteId: string; preview: string; elapsedMs: number; error?: string }
  | { phase: "complete"; total: number; processed: number; failed: number; edges: number; elapsedMs: number };

export interface ProcessOptions {
  onProgress?: (progress: ProcessProgress) => void;
  heartbeatMs?: number;
}

export async function processPending(store: KnowledgeStore, enricher: Enricher, limit = 100, options: ProcessOptions = {}): Promise<ProcessResult> {
  let processed = 0;
  let failed = 0;
  const errors: ProcessResult["errors"] = [];
  const notes = store.pendingNotes(limit);
  const runStarted = Date.now();
  options.onProgress?.({ phase: "start", total: notes.length });
  for (const [index, note] of notes.entries()) {
    const current = index + 1;
    const preview = note.rawText.replace(/\s+/g, " ").trim().slice(0, 72);
    const noteStarted = Date.now();
    options.onProgress?.({ phase: "note-start", current, total: notes.length, noteId: note.id, preview, elapsedMs: 0 });
    const heartbeat = options.onProgress ? setInterval(() => {
      options.onProgress?.({ phase: "heartbeat", current, total: notes.length, noteId: note.id, preview, elapsedMs: Date.now() - noteStarted });
    }, options.heartbeatMs ?? 5_000) : undefined;
    try {
      store.enrichNote(note.id, await enricher.enrich(note, store.enrichmentContext(note.id)), enricher.name, PROMPT_VERSION);
      processed += 1;
      options.onProgress?.({ phase: "note-complete", current, total: notes.length, noteId: note.id, preview, elapsedMs: Date.now() - noteStarted });
    } catch (error) {
      store.failNote(note.id);
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ noteId: note.id, message });
      options.onProgress?.({ phase: "note-failed", current, total: notes.length, noteId: note.id, preview, elapsedMs: Date.now() - noteStarted, error: message });
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
  }
  const edges = store.replaceDerivedEdges();
  options.onProgress?.({ phase: "complete", total: notes.length, processed, failed, edges, elapsedMs: Date.now() - runStarted });
  return { processed, failed, edges, errors };
}
