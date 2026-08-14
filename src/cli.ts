#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { HeuristicEnricher, OpenAICompatibleEnricher } from "./enrichment.js";
import { extractFile } from "./extractors.js";
import { processPending, type ProcessProgress } from "./pipeline.js";
import { PROMPT_VERSION } from "./enrichment.js";
import { KnowledgeStore } from "./store.js";
import { TelegramClient, type TelegramSyncProgress } from "./telegram.js";

const usage = `Digital Knowledge Network (v0.1)

Usage:
  dkn init [--db PATH]
  dkn ingest <file> [--title TITLE] [--db PATH]
  dkn process [--provider heuristic|openai] [--limit N] [--refresh] [--db PATH]
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
      provider: { type: "string", default: "heuristic" },
      limit: { type: "string", default: "100" },
      out: { type: "string", default: ".dkn/graph.json" },
      "chat-id": { type: "string" },
      refresh: { type: "boolean", default: false },
    },
  });
  const dbPath = resolve(values.db ?? ".dkn/knowledge.sqlite");
  const store = new KnowledgeStore(dbPath);
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
      const enricher = provider === "heuristic" ? new HeuristicEnricher() : provider === "openai" ? new OpenAICompatibleEnricher({
        baseUrl: process.env.DKN_LLM_BASE_URL ?? "http://127.0.0.1:8080/v1",
        apiKey: process.env.DKN_LLM_API_KEY ?? "local",
        model: process.env.DKN_LLM_MODEL ?? "LiquidAI/LFM2.5-2.6B",
      }) : (() => { throw new Error(`Unknown provider: ${provider}`); })();
      const result = await processPending(store, enricher, limit, { onProgress: reportProcessProgress });
      console.log(JSON.stringify({ requeued, ...result }, null, 2));
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

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
