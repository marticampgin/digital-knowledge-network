import type { Enrichment, EnrichmentContext, NoteRecord } from "./domain.js";
import { OpenAICompatibleJsonClient, parseJsonObject, type OpenAICompatibleOptions } from "./llm.js";
import { normalizeTags } from "./tags.js";

export interface Enricher {
  readonly name: string;
  enrich(note: NoteRecord, context: EnrichmentContext): Promise<Enrichment>;
}

export const PROMPT_VERSION = "atomic-passage-v3";

const STOP_WORDS = new Set(["about", "after", "again", "also", "and", "because", "been", "before", "being", "between", "could", "does", "from", "have", "into", "more", "most", "other", "should", "some", "such", "than", "that", "their", "then", "there", "these", "they", "this", "through", "very", "were", "what", "when", "where", "which", "while", "with", "would", "your"]);

export class HeuristicEnricher implements Enricher {
  readonly name = "heuristic-v1";

  async enrich(note: NoteRecord, _context: EnrichmentContext): Promise<Enrichment> {
    const plain = note.rawText.replace(/^#{1,6}\s+.*$/gm, "").replace(/\s+/g, " ").trim();
    const sentences = plain.match(/[^.!?]+[.!?]?/g)?.map((value) => value.trim()).filter(Boolean) ?? [plain];
    const coreIdea = (sentences[0] ?? plain).slice(0, 280);
    const counts = new Map<string, number>();
    for (const word of plain.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{3,}/gu) ?? []) {
      if (!STOP_WORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
    }
    const tags = normalizeTags([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([word]) => word));
    return { coreIdea, context: sentences.slice(1, 3).join(" ").slice(0, 500), tags, confidence: 0.35 };
  }
}

export class OpenAICompatibleEnricher implements Enricher {
  readonly name: string;
  private readonly client: OpenAICompatibleJsonClient;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.name = options.model;
    this.client = new OpenAICompatibleJsonClient(options);
  }

  async enrich(note: NoteRecord, context: EnrichmentContext): Promise<Enrichment> {
    const work = context.work;
    const workContext = work
      ? [`Type: ${work.kind}`, `Title: ${work.title}`, work.author ? `Author: ${work.author}` : "", work.edition ? `Edition: ${work.edition}` : "", work.identifier ? `Identifier: ${work.identifier}` : ""].filter(Boolean).join("\n")
      : "Source: not assigned";
    const result = await this.client.complete({
      task: "atomic-note-enrichment",
      promptVersion: PROMPT_VERSION,
      schemaName: "atomic_note",
      schema: {
        type: "object",
        properties: {
          coreIdea: { type: "string" },
          context: { type: "string" },
          tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 10 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["coreIdea", "context", "tags", "confidence"],
        additionalProperties: false,
      },
      system: "You turn one complete captured passage into exactly one faithful atomic knowledge note. Multiple labeled captures are consecutive evidence for the same note, not separate notes. Integrate them into a coherent explanation. The coreIdea may be detailed and multi-paragraph when the passage warrants it; do not shorten away reasoning, qualifications, examples, or causal links. Do not add facts absent from the supplied evidence or source metadata. Context should preserve useful supporting detail without repeating the core idea. Return JSON only with coreIdea, context, tags, confidence. Tags are 2-10 lowercase descriptive facets for human browsing; a separate task manages controlled concepts. Confidence measures only whether the supplied evidence supports your result.",
      user: `SOURCE METADATA\n${workContext}\nEvidence captures: ${context.evidenceCount}\n\nCOMPLETE PASSAGE\n${note.rawText}`,
      maxTokens: 2048,
    });
    return parseEnrichment(result.content);
  }
}

export function parseEnrichment(content: string): Enrichment {
  const value = parseJsonObject(content) as Partial<Enrichment>;
  if (typeof value.coreIdea !== "string" || !value.coreIdea.trim()) throw new Error("Model response is missing coreIdea");
  const tags = normalizeTags(Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : []);
  const confidence = typeof value.confidence === "number" ? Math.max(0, Math.min(1, value.confidence)) : 0.5;
  return { coreIdea: value.coreIdea.trim(), context: typeof value.context === "string" ? value.context.trim() : "", tags, confidence };
}
