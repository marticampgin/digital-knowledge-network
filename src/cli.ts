#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { HeuristicEnricher, OpenAICompatibleEnricher } from "./enrichment.js";
import { HeuristicConceptSelector, OpenAIConceptMaintenanceEvaluator, OpenAIConceptSelector } from "./concepts.js";
import { MiniLmEmbedder } from "./embeddings.js";
import { extractFile } from "./extractors.js";
import { processPending, type ProcessProgress } from "./pipeline.js";
import { PROMPT_VERSION } from "./enrichment.js";
import { KnowledgeStore } from "./store.js";
import { OpenAIWorkSummarizer, renderWorkSummaryMarkdown, type WorkSummaryProgress } from "./summaries.js";
import { TelegramClient, type TelegramSyncProgress } from "./telegram.js";

const usage = `Digital Knowledge Network (v0.1)

Usage:
  dkn init [--db PATH]
  dkn ingest <file> [--title TITLE] [--db PATH]
  dkn process [--provider heuristic|openai] [--limit N] [--refresh] [--refresh-concepts] [--db PATH]
  dkn summarize --work TITLE_OR_ID [--refresh] [--out PATH] [--db PATH]
  dkn telegram discover
  dkn telegram sync [--chat-id ID] [--db PATH]
  dkn status [--db PATH]
  dkn export [--out PATH] [--db PATH]

Inputs: text, Markdown, PNG/JPEG/WebP/TIFF, WAV/MP3/OGG/Opus/M4A/AAC/FLAC.
Atomic text boundaries: place --- on its own line, or use multiple Markdown headings.
Default database: .dkn/knowledge.sqlite
`;

async function main(): Promise<void> {
  const envPath = resolve(".env");
  if (existsSync(envPath)) loadEnvFile(envPath);
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(usage);
    return;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string", default: ".dkn/knowledge.sqlite" },
      title: { type: "string" },
      provider: { type: "string" },
      limit: { type: "string", default: "100" },
      out: { type: "string" },
      "chat-id": { type: "string" },
      work: { type: "string" },
      refresh: { type: "boolean", default: false },
      "refresh-concepts": { type: "boolean", default: false },
    },
  });
  const dbPath = resolve(values.db ?? ".dkn/knowledge.sqlite");
  const store = new KnowledgeStore(dbPath);
  let activeEmbedder: MiniLmEmbedder | undefined;
  try {
    if (command === "init") {
      console.log(JSON.stringify({ database: dbPath, initialized: true }, null, 2));
    } else if (command === "ingest") {
      const file = positionals[0];
      if (!file) throw new Error("ingest requires a file path");
      const prepared = await extractFile(file, values.title);
      const result = store.addSource(prepared.source, prepared.atomicTexts);
      console.log(JSON.stringify({ sourceId: result.source.id, duplicate: result.duplicate, notes: result.noteCount }, null, 2));
    } else if (command === "process") {
      const limit = Number.parseInt(values.limit ?? "100", 10);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
      const provider = values.provider ?? "heuristic";
      const requeued = values.refresh ? store.requeueOutdatedNotes(PROMPT_VERSION) : 0;
      const conceptsRequeued = values["refresh-concepts"] ? store.requeueConceptSelections() : 0;
      const enricher = provider === "heuristic" ? new HeuristicEnricher() : provider === "openai" ? new OpenAICompatibleEnricher({
        baseUrl: process.env.DKN_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
        apiKey: process.env.DKN_LLM_API_KEY ?? "local",
        model: process.env.DKN_LLM_MODEL ?? "LiquidAI/LFM2.5-2.6B",
      }) : (() => { throw new Error(`Unknown provider: ${provider}`); })();
      const llmOptions = {
        baseUrl: process.env.DKN_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
        apiKey: process.env.DKN_LLM_API_KEY ?? "local",
        model: process.env.DKN_LLM_MODEL ?? "LiquidAI/LFM2.5-2.6B",
      };
      activeEmbedder = new MiniLmEmbedder(process.env.DKN_EMBEDDING_MODEL, resolve(".dkn/models/transformers"));
      const result = await processPending(store, enricher, limit, {
        onProgress: reportProcessProgress,
        knowledge: {
          selector: provider === "openai" ? new OpenAIConceptSelector(llmOptions) : new HeuristicConceptSelector(),
          embedder: activeEmbedder,
          ...(provider === "openai" ? { maintenance: new OpenAIConceptMaintenanceEvaluator(llmOptions) } : {}),
        },
      });
      console.log(JSON.stringify({ requeued, conceptsRequeued, ...result }, null, 2));
    } else if (command === "summarize") {
      const query = values.work?.trim();
      if (!query) throw new Error("summarize requires --work TITLE_OR_ID");
      const works = store.listWorks();
      const normalizedQuery = query.toLocaleLowerCase();
      const exact = works.filter((work) => work.id === query || work.title.toLocaleLowerCase() === normalizedQuery);
      const matches = exact.length ? exact : works.filter((work) => work.title.toLocaleLowerCase().includes(normalizedQuery));
      if (!matches.length) throw new Error(`No registered work matches “${query}”. Available works: ${store.listWorks().map((work) => work.title).join(", ") || "none"}`);
      if (matches.length > 1) throw new Error(`“${query}” matches more than one work; use the exact title or work ID instead.`);
      const work = matches[0]!;
      const summarizer = new OpenAIWorkSummarizer({
        baseUrl: process.env.DKN_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
        apiKey: process.env.DKN_LLM_API_KEY ?? "local",
        model: process.env.DKN_LLM_MODEL ?? "LiquidAI/LFM2.5-2.6B",
      });
      const result = await summarizer.summarize(store, work, { refresh: values.refresh, onProgress: reportSummaryProgress });
      const output = resolve(values.out ?? `.dkn/summaries/${safeFilename(work.title)}.md`);
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, renderWorkSummaryMarkdown(work, result.summary), "utf8");
      console.log(JSON.stringify({ work: work.title, notes: result.summary.noteCount, cached: result.cached, summaryId: result.summary.id, output }, null, 2));
    } else if (command === "telegram") {
      const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? "");
      const action = positionals[0];
      if (action === "discover") {
        console.log(JSON.stringify(await client.discover(), null, 2));
      } else if (action === "sync") {
        const configured = values["chat-id"] ?? process.env.TELEGRAM_CHAT_ID ?? store.getSetting("telegram.chat_id");
        if (!configured || !/^-?\d+$/.test(configured)) throw new Error("Provide --chat-id ID once, or set TELEGRAM_CHAT_ID");
        console.log(JSON.stringify(await client.sync(store, Number(configured), { onProgress: reportTelegramProgress }), null, 2));
      } else {
        throw new Error("telegram requires 'discover' or 'sync'");
      }
    } else if (command === "status") {
      console.log(JSON.stringify(store.stats(), null, 2));
    } else if (command === "export") {
      const output = resolve(values.out ?? ".dkn/graph.json");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(store.exportGraph(), null, 2)}\n`, "utf8");
      console.log(JSON.stringify({ output }, null, 2));
    } else {
      throw new Error(`Unknown command '${command}'\n\n${usage}`);
    }
  } finally {
    await activeEmbedder?.dispose();
    store.close();
  }
}

function reportProcessProgress(progress: ProcessProgress): void {
  if (progress.phase === "start") {
    console.log(progress.total ? `[process] ${progress.total} note${progress.total === 1 ? "" : "s"} queued.` : "[process] No notes are waiting for enrichment; graph connections will still be refreshed.");
  } else if (progress.phase === "note-start") {
    console.log(`[process ${progress.current}/${progress.total}] Enriching ${progress.noteId.slice(0, 8)}: ${progress.preview || "(empty preview)"}`);
  } else if (progress.phase === "heartbeat") {
    console.log(`[process ${progress.current}/${progress.total}] Still generating on ${progress.noteId.slice(0, 8)} (${formatElapsed(progress.elapsedMs)})...`);
  } else if (progress.phase === "note-complete") {
    console.log(`[process ${progress.current}/${progress.total}] Completed ${progress.noteId.slice(0, 8)} in ${formatElapsed(progress.elapsedMs)}.`);
  } else if (progress.phase === "note-failed") {
    console.error(`[process ${progress.current}/${progress.total}] Failed ${progress.noteId.slice(0, 8)} after ${formatElapsed(progress.elapsedMs)}: ${progress.error}`);
  } else if (progress.phase === "concept-start") {
    console.log(`[concepts ${progress.current}/${progress.total}] Selecting controlled concepts for ${progress.noteId?.slice(0, 8)}...`);
  } else if (progress.phase === "concept-complete") {
    console.log(`[concepts ${progress.current}/${progress.total}] Assigned concepts in ${formatElapsed(progress.elapsedMs)}.`);
  } else if (progress.phase === "embedding-start") {
    console.log(`[embeddings] Creating ${progress.total} semantic vector${progress.total === 1 ? "" : "s"}...`);
  } else if (progress.phase === "model-download") {
    const percent = progress.progress === undefined ? "" : ` ${progress.progress.toFixed(0)}%`;
    console.log(`[embeddings] Model ${progress.label}${percent}`);
  } else if (progress.phase === "embedding-complete") {
    console.log(`[embeddings ${progress.current}/${progress.total}] Stored ${progress.noteId?.slice(0, 8)}.`);
  } else if (progress.phase === "maintenance-start") {
    console.log(`[concept maintenance ${progress.current}/${progress.total}] Evaluating ${progress.label}...`);
  } else if (progress.phase === "maintenance-complete") {
    console.log(`[concept maintenance ${progress.current}/${progress.total}] Proposal recorded in ${formatElapsed(progress.elapsedMs)}.`);
  } else if (progress.phase === "complete") {
    console.log(`[process] Finished ${progress.processed}/${progress.total}; ${progress.failed} failed; ${progress.edges} graph edges (${formatElapsed(progress.elapsedMs)}).`);
  }
}

function reportTelegramProgress(progress: TelegramSyncProgress): void {
  if (progress.phase === "start") {
    console.log(progress.total ? `[telegram] ${progress.total} new message${progress.total === 1 ? "" : "s"} found.` : "[telegram] No new messages found.");
  } else if (progress.phase === "message-start") {
    console.log(`[telegram ${progress.current}/${progress.total}] Importing message ${progress.messageId}...`);
  } else if (progress.phase === "heartbeat") {
    console.log(`[telegram ${progress.current}/${progress.total}] Still extracting message ${progress.messageId} (${formatElapsed(progress.elapsedMs)})...`);
  } else if (progress.phase === "message-complete") {
    console.log(`[telegram ${progress.current}/${progress.total}] Message ${progress.messageId}: ${progress.status} in ${formatElapsed(progress.elapsedMs)}.`);
  } else if (progress.phase === "message-failed") {
    console.error(`[telegram ${progress.current}/${progress.total}] Message ${progress.messageId} failed after ${formatElapsed(progress.elapsedMs)}: ${progress.error}`);
  } else if (progress.phase === "complete") {
    console.log(`[telegram] Synchronization finished in ${formatElapsed(progress.elapsedMs)}.`);
  }
}

function reportSummaryProgress(progress: WorkSummaryProgress): void {
  if (progress.phase === "start") {
    console.log(progress.cached ? `[summary] Reusing the current summary of ${progress.notes} notes.` : `[summary] Preparing ${progress.notes} atomic notes.`);
  } else if (progress.phase === "batch-start") {
    console.log(`[summary level ${progress.level} ${progress.current}/${progress.total}] Summarizing batch...`);
  } else if (progress.phase === "batch-complete") {
    console.log(`[summary level ${progress.level} ${progress.current}/${progress.total}] Completed in ${formatElapsed(progress.elapsedMs ?? 0)}.`);
  } else if (progress.phase === "synthesis-start") {
    console.log("[summary] Synthesizing the work overview...");
  } else if (progress.phase === "complete") {
    console.log(`[summary] ${progress.cached ? "Loaded" : "Generated"} summary covering ${progress.notes} notes in ${formatElapsed(progress.elapsedMs)}.`);
  }
}

function safeFilename(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").replace(/\s+/g, " ").replace(/[. ]+$/, "") || "work-summary";
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
