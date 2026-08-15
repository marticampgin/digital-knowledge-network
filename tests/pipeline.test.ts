import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeuristicEnricher, parseEnrichment } from "../src/enrichment.js";
import { parseConceptSelection } from "../src/concepts.js";
import { prepareFile, splitAtomicNotes } from "../src/ingest.js";
import { processPending } from "../src/pipeline.js";
import { KnowledgeStore } from "../src/store.js";
import { parsePassageCommand, parseSourceCommand } from "../src/telegram.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("knowledge pipeline", () => {
  it("splits explicit atomic note boundaries", () => {
    expect(splitAtomicNotes("First idea\n\n---\n\nSecond idea")).toEqual(["First idea", "Second idea"]);
  });

  it("ingests idempotently, enriches notes, and creates graph edges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const file = join(dir, "learning.md");
    writeFileSync(file, "# Feedback loops\nLearning improves through feedback.\n\n---\n\n# Fast feedback\nFast feedback improves deliberate learning.");
    const input = prepareFile(file);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      expect(store.addSource(input.source, input.atomicTexts)).toMatchObject({ duplicate: false, noteCount: 2 });
      expect(store.addSource(input.source, input.atomicTexts)).toMatchObject({ duplicate: true, noteCount: 2 });
      const result = await processPending(store, new HeuristicEnricher());
      expect(result).toMatchObject({ processed: 2, failed: 0 });
      expect(result.edges).toBeGreaterThanOrEqual(1);
      expect(store.stats()).toMatchObject({ sources: 1, notes: 2, notes_enriched: 2 });
      const graph = store.exportGraph();
      expect(graph.notes).toHaveLength(2);
      expect(graph.edges.some((edge) => edge.type === "source_sequence")).toBe(true);
    } finally {
      store.close();
    }
  });

  it("reports enrichment progress and heartbeats", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      store.addSource({ kind: "text", title: "Progress", origin: "progress", rawContent: "Progress evidence" }, ["Progress evidence"]);
      const phases: string[] = [];
      await processPending(store, {
        name: "slow-test",
        async enrich() {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { coreIdea: "Progress", context: "", tags: ["progress"], confidence: 1 };
        },
      }, 100, { heartbeatMs: 5, onProgress: (progress) => phases.push(progress.phase) });
      expect(phases).toEqual(expect.arrayContaining(["start", "note-start", "heartbeat", "note-complete", "complete"]));
    } finally {
      store.close();
    }
  });

  it("parses reasoning-model JSON safely", () => {
    expect(parseEnrichment('<think>private reasoning</think>\n```json\n{"coreIdea":"A claim","context":"Supported context","tags":["Customer_Experience","customer experience","Learning","learning"],"confidence":1.4}\n```')).toEqual({
      coreIdea: "A claim", context: "Supported context", tags: ["customer experience", "learning"], confidence: 1,
    });
  });

  it("repairs local-model JSON syntax before validating concept IDs", () => {
    const malformed = '{"existing":[{"conceptId":"known","confidence":0.9,"evidence":"direct evidence"}],"proposed":[{"preferredLabel":"new idea","definition":"A reusable idea","aliases":[],"confidence":0.8,"evidence":"supported"}';
    expect(parseConceptSelection(malformed, new Set(["known"]))).toMatchObject({
      existing: [{ conceptId: "known" }], proposed: [{ preferredLabel: "new idea" }],
    });
  });

  it("normalizes equivalent underscore and space tags without using tags as graph topology", () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      const left = store.addSource({ kind: "text", title: "Left", origin: "left", rawContent: "Left" }, ["Left"]);
      const right = store.addSource({ kind: "text", title: "Right", origin: "right", rawContent: "Right" }, ["Right"]);
      const [leftNote, rightNote] = store.pendingNotes();
      expect(leftNote && rightNote).toBeTruthy();
      store.enrichNote(leftNote!.id, { coreIdea: "Left", context: "", tags: ["customer_experience"], confidence: 1 }, "test", "test");
      store.enrichNote(rightNote!.id, { coreIdea: "Right", context: "", tags: ["customer experience"], confidence: 1 }, "test", "test");
      expect(store.replaceDerivedEdges()).toBe(0);
      expect(store.exportGraph().notes.map((note) => note.tags)).toEqual([["customer experience"], ["customer experience"]]);
      expect(left.duplicate || right.duplicate).toBe(false);
    } finally {
      store.close();
    }
  });

  it("registers a work and binds it to a Telegram topic", () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      const registered = store.upsertWork({ kind: "book", title: "The Everything Store" });
      const completedMetadata = store.upsertWork({ kind: "book", title: "The Everything Store", author: "Brad Stone" });
      expect(completedMetadata).toMatchObject({ created: false, work: { id: registered.work.id, author: "Brad Stone" } });
      store.bindTelegramTopic(-100123, 3, registered.work.id);
      const assigned = store.workForTelegramTopic(-100123, 3);
      expect(assigned).toMatchObject({ id: registered.work.id, kind: "book", title: "The Everything Store", author: "Brad Stone" });
      const added = store.addSource({
        kind: "telegram", title: "Capture", origin: "telegram://-100123/6", rawContent: "A passage", workId: assigned?.id,
      }, ["A passage"]);
      expect(added.source.workId).toBe(registered.work.id);
      expect(store.exportGraph()).toMatchObject({ schemaVersion: 3, works: [{ title: "The Everything Store" }] });
    } finally {
      store.close();
    }
  });

  it("builds a work-sequence backbone and mutual semantic-neighbor edges", () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      const work = store.upsertWork({ kind: "book", title: "Systems" }).work;
      const left = store.addSource({ kind: "text", title: "Page 1", origin: "page-1", rawContent: "Customer learning", workId: work.id, capturedAt: "2025-01-01T00:00:00.000Z" }, ["Customer learning"]);
      const right = store.addSource({ kind: "text", title: "Page 2", origin: "page-2", rawContent: "Feedback loops", workId: work.id, capturedAt: "2025-01-02T00:00:00.000Z" }, ["Feedback loops"]);
      const notes = store.pendingNotes();
      expect(notes).toHaveLength(2);
      store.enrichNote(notes[0]!.id, { coreIdea: "Learning from customers", context: "", tags: ["learning"], confidence: 1 }, "test", "test");
      store.enrichNote(notes[1]!.id, { coreIdea: "Feedback enables learning", context: "", tags: ["feedback"], confidence: 1 }, "test", "test");
      store.storeEmbedding(notes[0]!.id, "test-embedding", "left", [1, 0]);
      store.storeEmbedding(notes[1]!.id, "test-embedding", "right", [0.9, 0.1]);
      expect(store.replaceDerivedEdges({ embeddingModel: "test-embedding", withinWorkThreshold: 0.4 })).toBe(2);
      const edgeTypes = store.exportGraph().edges.map((edge) => edge.type);
      expect(edgeTypes).toEqual(expect.arrayContaining(["work_sequence", "semantic_similarity"]));
      expect(left.duplicate || right.duplicate).toBe(false);
    } finally {
      store.close();
    }
  });

  it("withholds weak concept candidates so novel ideas can emerge", () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      store.addSource({ kind: "text", title: "Novel", origin: "novel", rawContent: "A distinct idea" }, ["A distinct idea"]);
      const note = store.pendingNotes()[0]!;
      store.enrichNote(note.id, { coreIdea: "A distinct idea", context: "", tags: ["novelty"], confidence: 1 }, "test", "test");
      store.replaceNoteConcepts(note.id, { existing: [], proposed: [{ preferredLabel: "unrelated mechanism", definition: "A different mechanism", aliases: [], confidence: 1, evidence: "seed" }] }, "test", "seed");
      const concept = store.listConcepts()[0]!;
      store.storeEmbedding(note.id, "test-model", "note", [1, 0]);
      store.storeConceptEmbedding(concept.id, "test-model", "concept", [0, 1]);
      expect(store.conceptCandidates(note)).toEqual([]);
      store.storeConceptEmbedding(concept.id, "test-model", "concept-2", [0.9, 0.1]);
      expect(store.conceptCandidates(note).map((candidate) => candidate.id)).toEqual([concept.id]);
    } finally {
      store.close();
    }
  });

  it("parses explicit Telegram source commands without storing placeholder authors", () => {
    expect(parseSourceCommand("/source book | The Everything Store | Author Name")).toEqual({
      kind: "book", title: "The Everything Store", author: undefined, edition: undefined, identifier: undefined,
    });
    expect(parseSourceCommand("/source article | A Systems Article | Jane Doe")).toMatchObject({
      kind: "article", title: "A Systems Article", author: "Jane Doe",
    });
    expect(parseSourceCommand("ordinary note")).toBeUndefined();
  });

  it("coalesces an ordered Telegram album into one atomic note while preserving every source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      for (const messageId of [8, 6, 7]) {
        store.addSource({
          kind: "image", title: `Page ${messageId}`, origin: `telegram://chat/${messageId}`, rawContent: `Page ${messageId}`,
          metadata: { captureGroupKey: "telegram:chat:album:album-1", telegramMediaGroupId: "album-1", telegramMessageId: messageId },
        }, [`Page ${messageId}`]);
      }
      expect(store.coalesceCaptureGroups()).toMatchObject({ groups: 1, notesRebuilt: 1 });
      await processPending(store, new HeuristicEnricher());
      const graph = store.exportGraph();
      expect(graph.sources).toHaveLength(3);
      expect(graph.notes).toHaveLength(1);
      expect(graph.notes[0]?.captureGroupId).not.toBeNull();
      expect(graph.notes[0]?.rawText).toMatch(/MESSAGE 6[\s\S]*Page 6[\s\S]*MESSAGE 7[\s\S]*Page 7[\s\S]*MESSAGE 8[\s\S]*Page 8/);
    } finally {
      store.close();
    }
  });

  it("supports explicit passage sessions and unambiguous passage commands", () => {
    const dir = mkdtempSync(join(tmpdir(), "dkn-"));
    dirs.push(dir);
    const store = new KnowledgeStore(join(dir, "knowledge.sqlite"));
    try {
      const key = store.startTelegramPassage(-100123, 3, 20);
      expect(store.activeTelegramPassage(-100123, 3)).toBe(key);
      expect(store.endTelegramPassage(-100123, 3)).toBe(key);
      expect(store.activeTelegramPassage(-100123, 3)).toBeUndefined();
      expect(parsePassageCommand("/passage start")).toBe("start");
      expect(parsePassageCommand("/passage continue")).toBe("continue");
      expect(parsePassageCommand("/passage end")).toBe("end");
      expect(parsePassageCommand("/continue")).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
