import type { Enricher } from "./enrichment.js";
import { PROMPT_VERSION } from "./enrichment.js";
import type { ConceptMaintenanceEvaluator, ConceptSelector } from "./concepts.js";
import { embeddingInputHash, embeddingText, type Embedder } from "./embeddings.js";
import { KnowledgeStore } from "./store.js";

export interface ProcessResult {
  processed: number;
  failed: number;
  edges: number;
  errors: Array<{ noteId: string; message: string }>;
  conceptsAssigned: number;
  embeddingsCreated: number;
  mergeProposals: number;
}

export type ProcessProgress =
  | { phase: "start"; total: number }
  | { phase: "note-start" | "heartbeat" | "note-complete" | "note-failed"; current: number; total: number; noteId: string; preview: string; elapsedMs: number; error?: string }
  | { phase: "concept-start" | "concept-complete" | "embedding-start" | "embedding-complete" | "maintenance-start" | "maintenance-complete"; current: number; total: number; noteId?: string; label?: string; elapsedMs: number }
  | { phase: "model-download"; label: string; progress?: number }
  | { phase: "complete"; total: number; processed: number; failed: number; edges: number; elapsedMs: number };

export interface ProcessOptions {
  onProgress?: (progress: ProcessProgress) => void;
  heartbeatMs?: number;
  knowledge?: { selector: ConceptSelector; embedder: Embedder; maintenance?: ConceptMaintenanceEvaluator };
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
  let conceptsAssigned = 0;
  let embeddingsCreated = 0;
  let mergeProposals = 0;
  if (options.knowledge) {
    const embeddingJobs = store.enrichedNotes().flatMap((note) => {
      const text = embeddingText(note);
      const inputHash = embeddingInputHash(text, options.knowledge!.embedder.model);
      return store.embedding(note.id, options.knowledge!.embedder.model)?.inputHash === inputHash ? [] : [{ note, text, inputHash }];
    });
    if (embeddingJobs.length) {
      const started = Date.now();
      options.onProgress?.({ phase: "embedding-start", current: 0, total: embeddingJobs.length, elapsedMs: 0 });
      const vectors = await options.knowledge.embedder.embed(embeddingJobs.map((job) => job.text), (progress) => {
        if (progress.status === "progress" && progress.file) options.onProgress?.({ phase: "model-download", label: progress.file, ...(progress.progress === undefined ? {} : { progress: progress.progress }) });
      });
      for (const [index, job] of embeddingJobs.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding model returned no vector for note ${job.note.id}`);
        store.storeEmbedding(job.note.id, options.knowledge.embedder.model, job.inputHash, vector);
        embeddingsCreated += 1;
        options.onProgress?.({ phase: "embedding-complete", current: index + 1, total: embeddingJobs.length, noteId: job.note.id, elapsedMs: Date.now() - started });
      }
    }
    const conceptEmbeddingJobs = store.listConcepts().flatMap((concept) => {
      const text = `Concept: ${concept.preferredLabel}\nAliases: ${concept.aliases.join(", ") || "none"}\nDefinition: ${concept.definition}`;
      const inputHash = embeddingInputHash(text, options.knowledge!.embedder.model);
      return store.conceptEmbedding(concept.id, options.knowledge!.embedder.model)?.inputHash === inputHash ? [] : [{ concept, text, inputHash }];
    });
    if (conceptEmbeddingJobs.length) {
      const vectors = await options.knowledge.embedder.embed(conceptEmbeddingJobs.map((job) => job.text));
      for (const [index, job] of conceptEmbeddingJobs.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding model returned no vector for concept ${job.concept.id}`);
        store.storeConceptEmbedding(job.concept.id, options.knowledge.embedder.model, job.inputHash, vector);
      }
    }
    const conceptNotes = store.notesNeedingConcepts(options.knowledge.selector.promptVersion, limit);
    for (const [index, note] of conceptNotes.entries()) {
      const started = Date.now();
      options.onProgress?.({ phase: "concept-start", current: index + 1, total: conceptNotes.length, noteId: note.id, elapsedMs: 0 });
      const selection = await options.knowledge.selector.select(note, store.enrichmentContext(note.id), store.conceptCandidates(note));
      conceptsAssigned += store.replaceNoteConcepts(note.id, selection, options.knowledge.selector.name, options.knowledge.selector.promptVersion);
      options.onProgress?.({ phase: "concept-complete", current: index + 1, total: conceptNotes.length, noteId: note.id, elapsedMs: Date.now() - started });
    }
    const newConceptEmbeddingJobs = store.listConcepts().flatMap((concept) => {
      const text = `Concept: ${concept.preferredLabel}\nAliases: ${concept.aliases.join(", ") || "none"}\nDefinition: ${concept.definition}`;
      const inputHash = embeddingInputHash(text, options.knowledge!.embedder.model);
      return store.conceptEmbedding(concept.id, options.knowledge!.embedder.model)?.inputHash === inputHash ? [] : [{ concept, text, inputHash }];
    });
    if (newConceptEmbeddingJobs.length) {
      const vectors = await options.knowledge.embedder.embed(newConceptEmbeddingJobs.map((job) => job.text));
      for (const [index, job] of newConceptEmbeddingJobs.entries()) {
        const vector = vectors[index];
        if (!vector) throw new Error(`Embedding model returned no vector for concept ${job.concept.id}`);
        store.storeConceptEmbedding(job.concept.id, options.knowledge.embedder.model, job.inputHash, vector);
      }
    }
    if (options.knowledge.maintenance) {
      const pairs = store.conceptMaintenanceCandidates(options.knowledge.embedder.model);
      for (const [index, pair] of pairs.entries()) {
        const [left, right] = pair;
        const started = Date.now();
        options.onProgress?.({ phase: "maintenance-start", current: index + 1, total: pairs.length, label: `${left.preferredLabel} / ${right.preferredLabel}`, elapsedMs: 0 });
        const evaluation = await options.knowledge.maintenance.evaluate(left, right);
        store.addConceptMergeProposal(left, right, evaluation, options.knowledge.maintenance.name, options.knowledge.maintenance.promptVersion);
        mergeProposals += 1;
        options.onProgress?.({ phase: "maintenance-complete", current: index + 1, total: pairs.length, label: `${left.preferredLabel} / ${right.preferredLabel}`, elapsedMs: Date.now() - started });
      }
    }
  }
  const edges = store.replaceDerivedEdges(options.knowledge ? { embeddingModel: options.knowledge.embedder.model } : {});
  options.onProgress?.({ phase: "complete", total: notes.length, processed, failed, edges, elapsedMs: Date.now() - runStarted });
  return { processed, failed, edges, errors, conceptsAssigned, embeddingsCreated, mergeProposals };
}
