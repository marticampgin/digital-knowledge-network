#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { parseArgs } from "node:util";
import { HeuristicEnricher, OpenAICompatibleEnricher } from "./enrichment.js";
import { extractFile } from "./extractors.js";
import { processPending } from "./pipeline.js";
import { PROMPT_VERSION } from "./enrichment.js";
import { KnowledgeStore } from "./store.js";
import { TelegramClient } from "./telegram.js";

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
      console.log(JSON.stringify({ requeued, ...await processPending(store, enricher, limit) }, null, 2));
    } else if (command === "telegram") {
      const envPath = resolve(".env");
      if (existsSync(envPath)) loadEnvFile(envPath);
      const client = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN ?? "");
      const action = positionals[0];
      if (action === "discover") {
        console.log(JSON.stringify(await client.discover(), null, 2));
      } else if (action === "sync") {
        const configured = values["chat-id"] ?? process.env.TELEGRAM_CHAT_ID ?? store.getSetting("telegram.chat_id");
        if (!configured || !/^-?\d+$/.test(configured)) throw new Error("Provide --chat-id ID once, or set TELEGRAM_CHAT_ID");
        console.log(JSON.stringify(await client.sync(store, Number(configured)), null, 2));
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
