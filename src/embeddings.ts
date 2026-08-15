import { createHash } from "node:crypto";
import type { NoteRecord } from "./domain.js";

export const DEFAULT_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_VERSION = "note-representation-v1";

export interface EmbeddingProgress {
  status: string;
  file?: string;
  progress?: number;
}

export interface Embedder {
  readonly model: string;
  embed(texts: string[], onProgress?: (progress: EmbeddingProgress) => void): Promise<number[][]>;
  dispose(): Promise<void>;
}

interface FeatureExtractor {
  (texts: string[], options: { pooling: "mean"; normalize: true }): Promise<{ tolist(): number[][] | number[] }>;
  dispose(): Promise<void>;
}

export class MiniLmEmbedder implements Embedder {
  private extractor: FeatureExtractor | undefined;

  constructor(readonly model = DEFAULT_EMBEDDING_MODEL, private readonly cacheDir = ".dkn/models/transformers") {}

  async embed(texts: string[], onProgress?: (progress: EmbeddingProgress) => void): Promise<number[][]> {
    if (!texts.length) return [];
    if (!this.extractor) {
      const transformers = await import("@huggingface/transformers");
      transformers.env.cacheDir = this.cacheDir;
      transformers.env.useFSCache = true;
      const createPipeline = transformers.pipeline as unknown as (task: "feature-extraction", model: string, options: Record<string, unknown>) => Promise<FeatureExtractor>;
      this.extractor = await createPipeline("feature-extraction", this.model, {
        dtype: "q8",
        progress_callback: (value: unknown) => {
          const progress = value && typeof value === "object" ? value as Record<string, unknown> : {};
          onProgress?.({ status: String(progress.status ?? "unknown"), ...(typeof progress.file === "string" ? { file: progress.file } : {}), ...(typeof progress.progress === "number" ? { progress: progress.progress } : {}) });
        },
      });
    }
    const output = await this.extractor(texts, { pooling: "mean", normalize: true });
    const rows = output.tolist() as number[][] | number[];
    return Array.isArray(rows[0]) ? rows as number[][] : [rows as number[]];
  }

  async dispose(): Promise<void> {
    if (this.extractor) await this.extractor.dispose();
    this.extractor = undefined;
  }
}

export function embeddingText(note: NoteRecord, concepts: string[]): string {
  return [
    `Core idea: ${note.coreIdea ?? note.rawText.slice(0, 1200)}`,
    note.context ? `Context: ${note.context.slice(0, 1200)}` : "",
    concepts.length ? `Concepts: ${concepts.join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

export function embeddingInputHash(text: string, model: string): string {
  return createHash("sha256").update(`${EMBEDDING_VERSION}\0${model}\0${text}`).digest("hex");
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
