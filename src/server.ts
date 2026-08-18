import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { HeuristicEnricher, OpenAICompatibleEnricher } from "./enrichment.js";
import { OpenAIConceptMaintenanceEvaluator, OpenAIConceptSelector } from "./concepts.js";
import { MiniLmEmbedder } from "./embeddings.js";
import { extractFile } from "./extractors.js";
import { processPending } from "./pipeline.js";
import { KnowledgeStore } from "./store.js";
import { buildHierarchy, readGraphSettings, saveGraphSettings, type GraphSettings } from "./hierarchy.js";

const envPath = resolve(".env");
if (existsSync(envPath)) loadEnvFile(envPath);

const dataDir = resolve(process.env.DKN_DATA_DIR ?? ".dkn");
const dbPath = resolve(process.env.DKN_DB_PATH ?? `${dataDir}/knowledge.sqlite`);
const app = Fastify({ logger: true, bodyLimit: 25 * 1024 * 1024 });
const store = new KnowledgeStore(dbPath);

await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

app.get("/api/status", async () => ({ ...store.stats(), local: true }));

app.get("/api/graph", async () => {
  const graph = store.exportGraph();
  const hierarchy = buildHierarchy(store);
  const themeLabels = new Map(hierarchy.themes.map((theme) => [theme.id, theme.label]));
  const sources = new Map(graph.sources.map((source) => [source.id, source]));
  const works = new Map(graph.works.map((work) => [work.id, work]));
  const concepts = new Map(graph.concepts.map((concept) => [concept.id, concept]));
  const conceptsByNote = new Map<string, string[]>();
  for (const assignment of graph.noteConcepts) {
    const concept = concepts.get(assignment.conceptId);
    if (concept) conceptsByNote.set(assignment.noteId, [...(conceptsByNote.get(assignment.noteId) ?? []), concept.preferredLabel]);
  }
  return {
    nodes: graph.notes.map((note) => {
      const source = sources.get(note.sourceId);
      const work = source?.workId ? works.get(source.workId) : undefined;
      return {
        id: note.id,
        label: note.coreIdea ?? note.rawText.slice(0, 100),
        coreIdea: note.coreIdea,
        context: note.context,
        sourceText: note.rawText,
        tags: note.tags,
        concepts: conceptsByNote.get(note.id) ?? [],
        status: note.status,
        confidence: note.confidence,
        sourceId: note.sourceId,
        workId: work?.id ?? null,
        workTitle: work?.title ?? null,
        themeId: hierarchy.noteThemes[note.id] ?? null,
        themeLabel: themeLabels.get(hierarchy.noteThemes[note.id] ?? "") ?? null,
        sourceTitle: work?.title ?? source?.title ?? "Unknown source",
        sourceKind: source?.kind ?? "text",
        origin: source?.origin ?? "",
      };
    }),
    links: graph.edges.map((edge) => ({ source: edge.fromNoteId, target: edge.toNoteId, type: edge.type, weight: edge.weight, evidence: edge.evidence })),
    hierarchy,
  };
});

app.get("/api/graph/settings", async () => readGraphSettings(store));

app.put<{ Body: Partial<GraphSettings> }>("/api/graph/settings", async (request) => {
  const settings = saveGraphSettings(store, request.body ?? {});
  store.replaceDerivedEdges({
    semanticTopK: settings.noteNeighborCap,
    withinWorkThreshold: settings.noteSimilarityThreshold,
    crossWorkThreshold: 1.01,
  });
  return buildHierarchy(store, settings);
});

app.post("/api/import", async (request, reply) => {
  const part = await request.file();
  if (!part) return reply.code(400).send({ error: "Choose one file to import" });
  const safeName = basename(part.filename).replace(/[^a-zA-Z0-9._-]/g, "-");
  const incoming = resolve(dataDir, "tmp", "uploads");
  mkdirSync(incoming, { recursive: true });
  const tempPath = resolve(incoming, `upload-${Date.now()}-${safeName || `capture${extname(part.filename)}`}`);
  writeFileSync(tempPath, await part.toBuffer());
  try {
    const extracted = await extractFile(tempPath, basename(part.filename, extname(part.filename)), { dataDir });
    const added = store.addSource(extracted.source, extracted.atomicTexts);
    const processed = await processPending(store, new HeuristicEnricher());
    return { sourceId: added.source.id, duplicate: added.duplicate, notes: added.noteCount, processed };
  } finally {
    if (existsSync(tempPath)) rmSync(tempPath);
  }
});

app.post<{ Body: { provider?: string; limit?: number } }>("/api/process", async (request) => {
  const provider = request.body?.provider ?? "heuristic";
  const enricher = provider === "openai" ? new OpenAICompatibleEnricher({
    baseUrl: process.env.DKN_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
    apiKey: process.env.DKN_LLM_API_KEY ?? "local",
    model: process.env.DKN_LLM_MODEL ?? "LiquidAI/LFM2.5-2.6B",
  }) : new HeuristicEnricher();
  if (provider !== "openai") return processPending(store, enricher, request.body?.limit ?? 100);
  const options = {
    baseUrl: process.env.DKN_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
    apiKey: process.env.DKN_LLM_API_KEY ?? "local",
    model: process.env.DKN_LLM_MODEL ?? "LiquidAI/LFM2.5-2.6B",
  };
  const embedder = new MiniLmEmbedder(process.env.DKN_EMBEDDING_MODEL, resolve(dataDir, "models/transformers"));
  try {
    return await processPending(store, enricher, request.body?.limit ?? 100, { knowledge: {
      selector: new OpenAIConceptSelector(options), embedder, maintenance: new OpenAIConceptMaintenanceEvaluator(options),
    } });
  } finally {
    await embedder.dispose();
  }
});

app.post<{ Params: { id: string } }>("/api/notes/:id/review", async (request, reply) => {
  const reviewed = store.reviewNote(request.params.id);
  return reviewed ? { reviewed: true } : reply.code(409).send({ error: "Only enriched notes can be reviewed" });
});

const compiledWeb = resolve("dist/web");
if (existsSync(compiledWeb)) {
  await app.register(fastifyStatic, { root: compiledWeb, wildcard: false });
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

app.addHook("onClose", async () => store.close());

const port = Number(process.env.DKN_PORT ?? 4174);
await app.listen({ host: "127.0.0.1", port });

function shutdown(): void {
  void app.close().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
