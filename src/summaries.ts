import { createHash } from "node:crypto";
import type { JsonTask, JsonTaskResult, OpenAICompatibleOptions } from "./llm.js";
import { OpenAICompatibleJsonClient, parseJsonObject } from "./llm.js";
import type { NoteRecord, WorkRecord, WorkSummaryRecord } from "./domain.js";
import type { KnowledgeStore } from "./store.js";

export const WORK_SUMMARY_PROMPT_VERSION = "work-summary-v3";
export const WORK_SUMMARY_STRATEGY = "hierarchical-map-reduce-v1";

interface JsonCompleter {
  readonly options: OpenAICompatibleOptions;
  complete(task: JsonTask): Promise<JsonTaskResult>;
}

interface Digest {
  summary: string;
  themes: string[];
  keyIdeas: string[];
  tensions: string[];
  openQuestions: string[];
  coveredNoteRefs: string[];
}

interface FinalSynthesis extends Digest {
  takeaways: string[];
}

export type WorkSummaryProgress =
  | { phase: "start"; notes: number; cached: boolean }
  | { phase: "batch-start" | "batch-complete"; current: number; total: number; level: number; elapsedMs?: number }
  | { phase: "synthesis-start" }
  | { phase: "complete"; notes: number; batches: number; elapsedMs: number; cached: boolean };

export interface SummarizeWorkOptions {
  refresh?: boolean;
  chunkCharacters?: number;
  onProgress?: (progress: WorkSummaryProgress) => void;
}

export class OpenAIWorkSummarizer {
  readonly client: JsonCompleter;

  constructor(options: OpenAICompatibleOptions) {
    this.client = new OpenAICompatibleJsonClient(options);
  }

  async summarize(store: KnowledgeStore, work: WorkRecord, options: SummarizeWorkOptions = {}): Promise<{ summary: WorkSummaryRecord; cached: boolean }> {
    return summarizeWork(store, work, this.client, options);
  }
}

export async function summarizeWork(store: KnowledgeStore, work: WorkRecord, client: JsonCompleter, options: SummarizeWorkOptions = {}): Promise<{ summary: WorkSummaryRecord; cached: boolean }> {
  const startedAt = Date.now();
  const notes = store.enrichedNotesForWork(work.id);
  if (!notes.length) throw new Error(`No enriched notes belong to “${work.title}”. Run processing first.`);
  const citationMap = Object.fromEntries(notes.map((note, index) => [noteRef(index), note.id]));
  const packets = notes.map((note, index) => notePacket(store, note, noteRef(index)));
  const inputHash = createHash("sha256").update(JSON.stringify({
    promptVersion: WORK_SUMMARY_PROMPT_VERSION,
    work: { id: work.id, title: work.title, author: work.author, edition: work.edition },
    notes: notes.map((note, index) => ({ id: note.id, updatedAt: note.updatedAt, packet: packets[index] })),
  })).digest("hex");
  const existing = store.latestWorkSummary(work.id);
  if (!options.refresh && existing?.inputHash === inputHash && existing.promptVersion === WORK_SUMMARY_PROMPT_VERSION) {
    options.onProgress?.({ phase: "start", notes: notes.length, cached: true });
    options.onProgress?.({ phase: "complete", notes: notes.length, batches: 0, elapsedMs: Date.now() - startedAt, cached: true });
    return { summary: existing, cached: true };
  }

  options.onProgress?.({ phase: "start", notes: notes.length, cached: false });
  const budget = Math.max(4_000, options.chunkCharacters ?? Number(process.env.DKN_SUMMARY_CHUNK_CHARACTERS ?? 14_000));
  let groups = packByCharacters(packets, budget);
  let level = 1;
  let batches = 0;
  let digests: Digest[] = [];
  for (;;) {
    digests = [];
    for (let index = 0; index < groups.length; index += 1) {
      const batchStartedAt = Date.now();
      options.onProgress?.({ phase: "batch-start", current: index + 1, total: groups.length, level });
      digests.push(await summarizeBatch(client, work, groups[index] ?? [], level));
      batches += 1;
      options.onProgress?.({ phase: "batch-complete", current: index + 1, total: groups.length, level, elapsedMs: Date.now() - batchStartedAt });
    }
    const rendered = digests.map(renderDigest);
    if (rendered.join("\n\n").length <= budget || digests.length === 1 || level >= 4) break;
    groups = packByCharacters(rendered, budget);
    level += 1;
  }

  options.onProgress?.({ phase: "synthesis-start" });
  const synthesis = await synthesize(client, work, digests, notes.length);
  const summary = store.saveWorkSummary({
    workId: work.id,
    overview: synthesis.summary,
    themes: synthesis.themes,
    keyIdeas: synthesis.keyIdeas,
    tensions: synthesis.tensions,
    takeaways: synthesis.takeaways,
    openQuestions: synthesis.openQuestions,
    noteIds: notes.map((note) => note.id),
    citationMap,
    noteCount: notes.length,
    inputHash,
    strategy: WORK_SUMMARY_STRATEGY,
    model: client.options.model,
    promptVersion: WORK_SUMMARY_PROMPT_VERSION,
  });
  options.onProgress?.({ phase: "complete", notes: notes.length, batches, elapsedMs: Date.now() - startedAt, cached: false });
  return { summary, cached: false };
}

async function summarizeBatch(client: JsonCompleter, work: WorkRecord, entries: string[], level: number): Promise<Digest> {
  const label = level === 1 ? "ATOMIC NOTES" : "INTERMEDIATE SUMMARIES";
  const digest = await completeWithRetries(client, {
    task: "work-summary-batch",
    promptVersion: `${WORK_SUMMARY_PROMPT_VERSION}-batch`,
    schemaName: "work_summary_batch",
    schema: digestSchema(false),
    system: "You summarize a bounded group of atomic notes from one work. Faithfully preserve the author's reasoning, qualifications, examples, disagreements, and causal links. This is a summary of the user's captured notes, never a claim to cover the entire book. Consolidate repetition without inventing missing material. Keep the summary under 350 words and return at most five concise items in each list. Cite relevant note references such as [N003]. Return JSON only.",
    user: `WORK\n${workLabel(work)}\n\nLEVEL\n${level}\n\n${label}\n${entries.join("\n\n")}`,
    maxTokens: 1600,
  }, parseDigest);
  return { ...digest, coveredNoteRefs: referencesIn(entries) };
}

async function synthesize(client: JsonCompleter, work: WorkRecord, digests: Digest[], noteCount: number): Promise<FinalSynthesis> {
  const synthesis = await completeWithRetries(client, {
    task: "work-summary-synthesis",
    promptVersion: `${WORK_SUMMARY_PROMPT_VERSION}-synthesis`,
    schemaName: "work_summary_synthesis",
    schema: digestSchema(true),
    system: "You create a comprehensive overview of the user's captured atomic notes from one work. Do not imply that uncaptured portions of the work were reviewed. The summary field is the primary deliverable: write six to ten connected paragraphs, roughly 700–1,200 words, tracing the material's development and explaining relationships among strategy, culture, operations, technology, and consequences when supported. Do not open with 'comprehensive overview', merely enumerate concept labels, or collapse the narrative into one paragraph. Cite supporting note references such as [N003] in every paragraph. Then provide non-repetitive themes, key ideas, tensions, practical takeaways, and open questions, with at most twelve concise items in each list. Return JSON only.",
    user: `WORK\n${workLabel(work)}\n\nCOVERAGE\n${noteCount} atomic notes\n\nBATCH SUMMARIES\n${digests.map(renderDigest).join("\n\n")}`,
    maxTokens: 3072,
  }, parseFinalSynthesis);
  return { ...synthesis, coveredNoteRefs: [...new Set(digests.flatMap((digest) => digest.coveredNoteRefs))].sort() };
}

async function completeWithRetries<T>(client: JsonCompleter, task: JsonTask, parser: (value: Record<string, unknown>) => T): Promise<T> {
  let error: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const request = attempt === 1 ? task : { ...task, user: `${task.user}\n\nRETRY ${attempt}: The previous response was invalid. Return one complete, concise JSON object matching the schema exactly. Do not repeat list items or commentary.` };
      return parser(parseJsonObject((await client.complete(request)).content));
    } catch (caught) {
      error = caught;
    }
  }
  throw error instanceof Error ? error : new Error("Work summary model returned invalid structured output");
}

function digestSchema(final: boolean): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    summary: { type: "string", maxLength: final ? 8_000 : 3_000 }, themes: stringArraySchema(final), keyIdeas: stringArraySchema(final), tensions: stringArraySchema(final),
    openQuestions: stringArraySchema(final),
  };
  if (final) properties.takeaways = stringArraySchema(true);
  return { type: "object", additionalProperties: false, properties, required: Object.keys(properties) };
}

function stringArraySchema(final: boolean): Record<string, unknown> {
  return { type: "array", maxItems: final ? 12 : 5, items: { type: "string", maxLength: 500 } };
}

function parseDigest(value: Record<string, unknown>): Digest {
  const summary = text(value.summary);
  if (!summary) throw new Error("Summary response omitted its overview");
  return { summary, themes: strings(value.themes), keyIdeas: strings(value.keyIdeas), tensions: strings(value.tensions), openQuestions: strings(value.openQuestions), coveredNoteRefs: [] };
}

function parseFinalSynthesis(value: Record<string, unknown>): FinalSynthesis {
  const digest = parseDigest(value);
  return { ...digest, summary: paragraphize(digest.summary), takeaways: strings(value.takeaways) };
}

function notePacket(store: KnowledgeStore, note: NoteRecord, reference: string): string {
  const concepts = store.conceptsForNote(note.id).map((concept) => concept.preferredLabel).join(", ") || "unassigned";
  return `[${reference}]\nPrimary concept: ${concepts}\nCore idea: ${note.coreIdea ?? note.rawText}\nContext: ${note.context ?? ""}\nDescriptive tags: ${note.tags.join(", ")}`;
}

function renderDigest(digest: Digest, index?: number): string {
  return `${index === undefined ? "" : `BATCH ${index + 1}\n`}Summary: ${digest.summary}\nThemes: ${digest.themes.join(" | ")}\nKey ideas: ${digest.keyIdeas.join(" | ")}\nTensions: ${digest.tensions.join(" | ")}\nOpen questions: ${digest.openQuestions.join(" | ")}\nCovered notes: ${digest.coveredNoteRefs.join(", ")}`;
}

function workLabel(work: WorkRecord): string {
  return `${work.kind}: ${work.title}${work.author ? ` by ${work.author}` : ""}${work.edition ? ` (${work.edition})` : ""}`;
}

function packByCharacters(items: string[], budget: number): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const item of items) {
    if (current.length && length + item.length + 2 > budget) {
      groups.push(current);
      current = [];
      length = 0;
    }
    current.push(item);
    length += item.length + 2;
  }
  if (current.length) groups.push(current);
  return groups;
}

function noteRef(index: number): string {
  return `N${String(index + 1).padStart(3, "0")}`;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean).slice(0, 16) : [];
}

function referencesIn(entries: string[]): string[] {
  return [...new Set([...entries.join("\n").matchAll(/\bN\d{3,}\b/g)].map((match) => match[0]))].sort();
}

function paragraphize(value: string): string {
  if (value.split(/\n\s*\n/).filter((part) => part.trim()).length > 1) return value;
  const sentences = [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(value)].map((part) => part.segment.trim()).filter(Boolean);
  if (sentences.length < 6) return value;
  const paragraphs: string[] = [];
  let current: string[] = [];
  let words = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).length;
    if (current.length && words >= 120 && words + sentenceWords > 180) {
      paragraphs.push(current.join(" "));
      current = [];
      words = 0;
    }
    current.push(sentence);
    words += sentenceWords;
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n\n");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function renderWorkSummaryMarkdown(work: WorkRecord, summary: WorkSummaryRecord): string {
  const section = (heading: string, values: string[]) => values.length ? `\n## ${heading}\n\n${values.map((value) => `- ${value}`).join("\n")}\n` : "";
  return `# Captured-notes summary: ${work.title}\n\n${work.author ? `**Author:** ${work.author}  \n` : ""}**Coverage:** ${summary.noteCount} atomic notes  \n**Generated:** ${summary.createdAt}  \n**Model:** ${summary.model}\n\n> This summarizes only the material captured in Digital Knowledge Network, not necessarily the entire work.\n\n## Overview\n\n${summary.overview}\n${section("Themes", summary.themes)}${section("Key ideas", summary.keyIdeas)}${section("Tensions and changes", summary.tensions)}${section("Takeaways", summary.takeaways)}${section("Open questions", summary.openQuestions)}\n## Citation map\n\n${Object.entries(summary.citationMap).map(([reference, noteId]) => `- [${reference}] ${noteId}`).join("\n")}\n`;
}
