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
  workId: string | null;
  workTitle: string | null;
  themeId: string | null;
  themeLabel: string | null;
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
  hierarchy: HierarchyGraph;
}

export interface GraphSettings {
  noteNeighborCap: number;
  noteSimilarityThreshold: number;
  maxThemesPerWork: number;
  minNotesPerTheme: number;
  maxThemeShare: number;
  themeMatchCap: number;
  workNeighborCap: number;
  workSimilarityThreshold: number;
}

export interface ThemeCell {
  id: string; workId: string; label: string; noteIds: string[]; noteCount: number;
  representativeNoteId: string; concepts: string[];
}

export interface WorkCell {
  id: string; title: string; author: string | null; kind: string; noteCount: number;
  themeCount: number; summary: string | null; themeIds: string[];
}

export interface ThemeMatch { sourceThemeId: string; targetThemeId: string; similarity: number; }
export interface WorkRelationship { source: string; target: string; weight: number; evidence: ThemeMatch[]; }
export interface HierarchyGraph {
  version: string; settings: GraphSettings; works: WorkCell[]; themes: ThemeCell[];
  workLinks: WorkRelationship[]; noteThemes: Record<string, string>;
}
