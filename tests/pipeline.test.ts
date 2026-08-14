import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HeuristicEnricher, parseEnrichment } from "../src/enrichment.js";
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

  it("connects equivalent underscore and space tags", () => {
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
      expect(store.replaceDerivedEdges()).toBe(1);
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
      expect(store.exportGraph()).toMatchObject({ schemaVersion: 2, works: [{ title: "The Everything Store" }] });
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
