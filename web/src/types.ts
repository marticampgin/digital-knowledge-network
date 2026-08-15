export type SourceKind = "text" | "markdown" | "image" | "audio" | "telegram";
export type RelationType = "source_sequence" | "work_sequence" | "capture_sequence" | "explicit_reference" | "semantic_similarity";

export interface GraphNode {
  id: string;
  label: string;
  coreIdea: string | null;
  context: string | null;
  sourceText: string;
  tags: string[];
  concepts: string[];
  status: string;
  confidence: number | null;
  sourceId: string;
  sourceTitle: string;
  sourceKind: SourceKind;
  origin: string;
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string | GraphNode;
  target: string | GraphNode;
  type: RelationType;
  weight: number;
  evidence: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
