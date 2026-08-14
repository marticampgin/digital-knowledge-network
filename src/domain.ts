export type SourceKind = "text" | "markdown" | "image" | "audio" | "telegram";
export type NoteStatus = "captured" | "extracted" | "enriched" | "reviewed" | "failed";
export type EdgeType = "source_sequence" | "capture_sequence" | "shared_tag" | "explicit_reference" | "semantic_similarity";
export type WorkKind = "book" | "article" | "website" | "audio_video" | "other";

export interface WorkInput {
  kind: WorkKind;
  title: string;
  author?: string | undefined;
  edition?: string | undefined;
  identifier?: string | undefined;
}

export interface WorkRecord {
  id: string;
  kind: WorkKind;
  title: string;
  author: string | null;
  edition: string | null;
  identifier: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SourceInput {
  kind: SourceKind;
  title: string;
  origin: string;
  rawContent: string;
  workId?: string | undefined;
  capturedAt?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface SourceRecord {
  id: string;
  kind: SourceKind;
  title: string;
  origin: string;
  rawContent: string;
  workId: string | null;
  contentHash: string;
  capturedAt: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface NoteRecord {
  id: string;
  sourceId: string;
  captureGroupId: string | null;
  ordinal: number;
  rawText: string;
  coreIdea: string | null;
  context: string | null;
  tags: string[];
  confidence: number | null;
  status: NoteStatus;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnrichmentContext {
  work: Pick<WorkRecord, "kind" | "title" | "author" | "edition" | "identifier"> | null;
  evidenceCount: number;
  sourceTitles: string[];
}

export interface Enrichment {
  coreIdea: string;
  context: string;
  tags: string[];
  confidence: number;
}

export interface EdgeRecord {
  id: string;
  fromNoteId: string;
  toNoteId: string;
  type: EdgeType;
  weight: number;
  evidence: string;
  createdAt: string;
}

export interface GraphExport {
  schemaVersion: 2;
  exportedAt: string;
  works: WorkRecord[];
  sources: SourceRecord[];
  notes: NoteRecord[];
  edges: EdgeRecord[];
}
