import type { ConceptRecord, ConceptSelection, EnrichmentContext, NoteRecord } from "./domain.js";
import { OpenAICompatibleJsonClient, parseJsonObject, type JsonTask, type OpenAICompatibleOptions } from "./llm.js";

export const CONCEPT_SELECTION_PROMPT_VERSION = "concept-selection-v1";
export const CONCEPT_MAINTENANCE_PROMPT_VERSION = "concept-maintenance-v1";

export interface ConceptSelector {
  readonly name: string;
  readonly promptVersion: string;
  select(note: NoteRecord, context: EnrichmentContext, candidates: ConceptRecord[]): Promise<ConceptSelection>;
}

export interface MergeEvaluation {
  recommendation: "merge" | "alias" | "keep_separate";
  confidence: number;
  rationale: string;
}

export interface ConceptMaintenanceEvaluator {
  readonly name: string;
  readonly promptVersion: string;
  evaluate(left: ConceptRecord, right: ConceptRecord): Promise<MergeEvaluation>;
}

export class HeuristicConceptSelector implements ConceptSelector {
  readonly name = "heuristic-concepts-v1";
  readonly promptVersion = CONCEPT_SELECTION_PROMPT_VERSION;

  async select(note: NoteRecord, _context: EnrichmentContext, candidates: ConceptRecord[]): Promise<ConceptSelection> {
    const byLabel = new Map(candidates.flatMap((concept) => [concept.preferredLabel, ...concept.aliases].map((label) => [normalizeConceptLabel(label), concept] as const)));
    const existing = [];
    const proposed = [];
    for (const tag of note.tags.slice(0, 6)) {
      const match = byLabel.get(normalizeConceptLabel(tag));
      if (match) existing.push({ conceptId: match.id, confidence: 0.7, evidence: `Matches generated tag “${tag}”` });
      else proposed.push({ preferredLabel: normalizeConceptLabel(tag), definition: `Concept represented by the note’s “${tag}” tag.`, aliases: [], confidence: 0.5, evidence: `Generated tag “${tag}”` });
    }
    return { existing, proposed };
  }
}

export class OpenAIConceptSelector implements ConceptSelector {
  readonly name: string;
  readonly promptVersion = CONCEPT_SELECTION_PROMPT_VERSION;
  private readonly client: OpenAICompatibleJsonClient;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.model;
    this.client = new OpenAICompatibleJsonClient(options);
  }

  async select(note: NoteRecord, context: EnrichmentContext, candidates: ConceptRecord[]): Promise<ConceptSelection> {
    const registry = candidates.length
      ? candidates.map((concept) => `${concept.id} | ${concept.preferredLabel} | aliases: ${concept.aliases.join(", ") || "none"} | ${concept.definition}`).join("\n")
      : "The registry is empty.";
    const work = context.work ? `${context.work.kind}: ${context.work.title}${context.work.author ? ` by ${context.work.author}` : ""}` : "Unassigned source";
    const task: JsonTask = {
      task: "concept-selection",
      promptVersion: this.promptVersion,
      schemaName: "concept_selection",
      schema: {
        type: "object",
        properties: {
          existing: { type: "array", maxItems: 8, items: { type: "object", properties: {
            conceptId: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "string" },
          }, required: ["conceptId", "confidence", "evidence"], additionalProperties: false } },
          proposed: { type: "array", maxItems: 4, items: { type: "object", properties: {
            preferredLabel: { type: "string" }, definition: { type: "string" }, aliases: { type: "array", items: { type: "string" }, maxItems: 5 },
            confidence: { type: "number", minimum: 0, maximum: 1 }, evidence: { type: "string" },
          }, required: ["preferredLabel", "definition", "aliases", "confidence", "evidence"], additionalProperties: false } },
        },
        required: ["existing", "proposed"],
        additionalProperties: false,
      },
      system: `You are the concept-selection task in a personal knowledge system. Analyze exactly one atomic note. Reuse concepts from the supplied registry whenever their meaning fits; concept IDs must be copied exactly. Propose a new concept only when no existing concept genuinely captures the idea. Concepts should be reusable intellectual ideas, mechanisms, practices, or phenomena—not people, book titles, generic words, sentence fragments, or near-duplicates. Prefer 2-6 precise concepts. A new preferred label is lowercase natural language without underscores. Definitions must distinguish the concept from nearby concepts. Evidence must quote or closely point to the supplied note. Do not merge, rename, or evaluate the registry; that belongs to a separate maintenance task. Return JSON only.`,
      user: `SOURCE\n${work}\n\nATOMIC NOTE\nCore idea: ${note.coreIdea ?? ""}\nContext: ${note.context ?? ""}\nCanonical text: ${note.rawText}\n\nCURRENT CONCEPT REGISTRY\n${registry}`,
      maxTokens: 2048,
    };
    return completeWithJsonRetry(this.client, task, (content) => parseConceptSelection(content, new Set(candidates.map((candidate) => candidate.id))));
  }
}

export class OpenAIConceptMaintenanceEvaluator implements ConceptMaintenanceEvaluator {
  readonly name: string;
  readonly promptVersion = CONCEPT_MAINTENANCE_PROMPT_VERSION;
  private readonly client: OpenAICompatibleJsonClient;

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.model;
    this.client = new OpenAICompatibleJsonClient(options);
  }

  async evaluate(left: ConceptRecord, right: ConceptRecord): Promise<MergeEvaluation> {
    const task: JsonTask = {
      task: "concept-maintenance",
      promptVersion: this.promptVersion,
      schemaName: "concept_maintenance",
      schema: {
        type: "object",
        properties: {
          recommendation: { type: "string", enum: ["merge", "alias", "keep_separate"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
        },
        required: ["recommendation", "confidence", "rationale"],
        additionalProperties: false,
      },
      system: `You are the concept-registry maintenance task. Compare exactly two existing concepts. Recommend “merge” only when they denote the same concept, “alias” when one label is simply an alternative name for the other, and “keep_separate” when they overlap but remain meaningfully distinct. Preserve useful conceptual distinctions. You do not assign concepts to notes and you never apply changes; you only produce an auditable proposal. Return JSON only.`,
      user: `CONCEPT A\nLabel: ${left.preferredLabel}\nAliases: ${left.aliases.join(", ") || "none"}\nDefinition: ${left.definition}\n\nCONCEPT B\nLabel: ${right.preferredLabel}\nAliases: ${right.aliases.join(", ") || "none"}\nDefinition: ${right.definition}`,
      maxTokens: 512,
    };
    return completeWithJsonRetry(this.client, task, (content) => {
      const value = parseJsonObject(content);
      const recommendation = value.recommendation;
      if (recommendation !== "merge" && recommendation !== "alias" && recommendation !== "keep_separate") throw new Error("Invalid concept-maintenance recommendation");
      return {
        recommendation,
        confidence: clamp(typeof value.confidence === "number" ? value.confidence : 0.5),
        rationale: typeof value.rationale === "string" ? value.rationale.trim() : "",
      };
    });
  }
}

export function parseConceptSelection(content: string, allowedIds: Set<string>): ConceptSelection {
  const value = parseJsonObject(content);
  const existing = Array.isArray(value.existing) ? value.existing.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.conceptId !== "string" || !allowedIds.has(candidate.conceptId)) return [];
    return [{ conceptId: candidate.conceptId, confidence: clamp(typeof candidate.confidence === "number" ? candidate.confidence : 0.5), evidence: clean(candidate.evidence) }];
  }) : [];
  const proposed = Array.isArray(value.proposed) ? value.proposed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Record<string, unknown>;
    const preferredLabel = normalizeConceptLabel(clean(candidate.preferredLabel));
    if (!preferredLabel) return [];
    return [{
      preferredLabel,
      definition: clean(candidate.definition),
      aliases: Array.isArray(candidate.aliases) ? [...new Set(candidate.aliases.map(clean).map(normalizeConceptLabel).filter(Boolean))] : [],
      confidence: clamp(typeof candidate.confidence === "number" ? candidate.confidence : 0.5),
      evidence: clean(candidate.evidence),
    }];
  }) : [];
  return { existing, proposed };
}

export function normalizeConceptLabel(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[_-]+/g, " ").replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

async function completeWithJsonRetry<T>(client: OpenAICompatibleJsonClient, task: JsonTask, parse: (content: string) => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retryRequirement = attempt === 1
      ? "The previous response was invalid JSON. Return one concise, complete JSON object within the schema and output limit."
      : "The previous responses were invalid JSON. Return at most 3 existing concepts and 2 proposed concepts. Keep every definition under 25 words and every evidence string under 20 words. Close every array and object.";
    const request = attempt === 0 ? task : { ...task, user: `${task.user}\n\nRETRY REQUIREMENT\n${retryRequirement}` };
    try {
      return parse((await client.complete(request)).content);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
