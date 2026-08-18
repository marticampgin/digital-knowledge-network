import { createHash } from "node:crypto";
import type { NoteRecord, WorkRecord } from "./domain.js";
import { cosineSimilarity } from "./embeddings.js";
import type { KnowledgeStore } from "./store.js";

export const GRAPH_SETTINGS_KEY = "graph.hierarchy.settings.v1";
export const HIERARCHY_VERSION = "semantic-hierarchy-v1";

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

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  noteNeighborCap: 4,
  noteSimilarityThreshold: 0.55,
  maxThemesPerWork: 8,
  minNotesPerTheme: 2,
  maxThemeShare: 0.3,
  themeMatchCap: 3,
  workNeighborCap: 4,
  workSimilarityThreshold: 0.55,
};

export interface ThemeCell {
  id: string;
  workId: string;
  label: string;
  noteIds: string[];
  noteCount: number;
  representativeNoteId: string;
}

export interface WorkCell {
  id: string;
  title: string;
  author: string | null;
  kind: string;
  noteCount: number;
  themeCount: number;
  themeIds: string[];
  summary: string | null;
  summaryUpdatedAt: string | null;
}

export interface WorkRelationship {
  source: string;
  target: string;
  weight: number;
  evidence: Array<{ sourceThemeId: string; targetThemeId: string; sourceTheme: string; targetTheme: string; similarity: number }>;
}

export interface HierarchyGraph {
  version: typeof HIERARCHY_VERSION;
  settings: GraphSettings;
  works: WorkCell[];
  themes: ThemeCell[];
  noteThemes: Record<string, string>;
  workLinks: WorkRelationship[];
}

interface InternalTheme extends ThemeCell {
  centroid: number[];
}

interface VectorNote {
  note: NoteRecord;
  vector: number[];
}

export function readGraphSettings(store: KnowledgeStore): GraphSettings {
  const stored = store.getSetting(GRAPH_SETTINGS_KEY);
  if (!stored) return { ...DEFAULT_GRAPH_SETTINGS };
  try {
    return normalizeGraphSettings(JSON.parse(stored) as Partial<GraphSettings>);
  } catch {
    return { ...DEFAULT_GRAPH_SETTINGS };
  }
}

export function saveGraphSettings(store: KnowledgeStore, input: Partial<GraphSettings>): GraphSettings {
  const settings = normalizeGraphSettings(input);
  store.setSetting(GRAPH_SETTINGS_KEY, JSON.stringify(settings));
  return settings;
}

export function normalizeGraphSettings(input: Partial<GraphSettings>): GraphSettings {
  return {
    noteNeighborCap: integer(input.noteNeighborCap, DEFAULT_GRAPH_SETTINGS.noteNeighborCap, 1, 12),
    noteSimilarityThreshold: decimal(input.noteSimilarityThreshold, DEFAULT_GRAPH_SETTINGS.noteSimilarityThreshold, 0.2, 0.95),
    maxThemesPerWork: integer(input.maxThemesPerWork, DEFAULT_GRAPH_SETTINGS.maxThemesPerWork, 1, 20),
    minNotesPerTheme: integer(input.minNotesPerTheme, DEFAULT_GRAPH_SETTINGS.minNotesPerTheme, 1, 12),
    maxThemeShare: decimal(input.maxThemeShare, DEFAULT_GRAPH_SETTINGS.maxThemeShare, 0.15, 0.8),
    themeMatchCap: integer(input.themeMatchCap, DEFAULT_GRAPH_SETTINGS.themeMatchCap, 1, 8),
    workNeighborCap: integer(input.workNeighborCap, DEFAULT_GRAPH_SETTINGS.workNeighborCap, 1, 12),
    workSimilarityThreshold: decimal(input.workSimilarityThreshold, DEFAULT_GRAPH_SETTINGS.workSimilarityThreshold, 0.2, 0.95),
  };
}

export function buildHierarchy(store: KnowledgeStore, settings = readGraphSettings(store)): HierarchyGraph {
  const embeddingModel = store.getSetting("embedding.model");
  const works = store.listWorks();
  const internalThemes: InternalTheme[] = [];
  const workCells: WorkCell[] = [];
  const noteThemes: Record<string, string> = {};

  for (const work of works) {
    const notes = store.enrichedNotesForWork(work.id);
    const vectorNotes = embeddingModel ? notes.flatMap((note) => {
      const vector = store.embedding(note.id, embeddingModel)?.vector;
      return vector?.length ? [{ note, vector }] : [];
    }) : [];
    const themes = clusterWork(store, work, vectorNotes, settings);
    for (const theme of themes) {
      internalThemes.push(theme);
      for (const noteId of theme.noteIds) noteThemes[noteId] = theme.id;
    }
    const latestSummary = store.latestWorkSummary(work.id);
    workCells.push({
      id: work.id,
      title: work.title,
      author: work.author,
      kind: work.kind,
      noteCount: notes.length,
      themeCount: themes.length,
      themeIds: themes.map((theme) => theme.id),
      summary: latestSummary?.overview ?? null,
      summaryUpdatedAt: latestSummary?.createdAt ?? null,
    });
  }

  return {
    version: HIERARCHY_VERSION,
    settings,
    works: workCells,
    themes: internalThemes.map(({ centroid: _centroid, ...theme }) => theme),
    noteThemes,
    workLinks: buildWorkLinks(internalThemes, settings),
  };
}

function clusterWork(store: KnowledgeStore, work: WorkRecord, items: VectorNote[], settings: GraphSettings): InternalTheme[] {
  if (!items.length) return [];
  const maximumBySize = Math.max(1, Math.floor(items.length / settings.minNotesPerTheme));
  const target = Math.max(1, Math.min(settings.maxThemesPerWork, maximumBySize, Math.ceil(Math.sqrt(items.length))));
  const centroids = initializeCentroids(items, target);
  let assignments = new Array<number>(items.length).fill(-1);
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const next = constrainedAssignments(items, centroids, settings.minNotesPerTheme, settings.maxThemeShare);
    const changed = next.some((value, index) => value !== assignments[index]);
    assignments = next;
    recomputeCentroids(items, assignments, centroids);
    if (!changed && iteration > 0) break;
  }

  const clusterIds = [...new Set(assignments)].sort((left, right) => left - right);
  return clusterIds.map((clusterId) => {
    const members = items.filter((_item, index) => assignments[index] === clusterId);
    const centroid = meanVector(members.map((member) => member.vector));
    const representative = members.toSorted((left, right) => cosineSimilarity(right.vector, centroid) - cosineSimilarity(left.vector, centroid) || left.note.id.localeCompare(right.note.id))[0]!;
    const noteIds = members.map((member) => member.note.id).sort();
    return {
      id: stableId("theme", work.id, ...noteIds),
      workId: work.id,
      label: themeLabel(store, members, representative.note),
      noteIds,
      noteCount: noteIds.length,
      representativeNoteId: representative.note.id,
      centroid,
    };
  }).sort((left, right) => right.noteCount - left.noteCount || left.label.localeCompare(right.label));
}

function initializeCentroids(items: VectorNote[], count: number): number[][] {
  const global = meanVector(items.map((item) => item.vector));
  const first = items.toSorted((left, right) => cosineSimilarity(right.vector, global) - cosineSimilarity(left.vector, global) || left.note.id.localeCompare(right.note.id))[0]!;
  const selected = [first.vector.slice()];
  while (selected.length < count) {
    const candidate = items.toSorted((left, right) => {
      const leftDistance = Math.min(...selected.map((centroid) => 1 - cosineSimilarity(left.vector, centroid)));
      const rightDistance = Math.min(...selected.map((centroid) => 1 - cosineSimilarity(right.vector, centroid)));
      return rightDistance - leftDistance || left.note.id.localeCompare(right.note.id);
    })[0];
    if (!candidate) break;
    selected.push(candidate.vector.slice());
  }
  return selected;
}

function recomputeCentroids(items: VectorNote[], assignments: number[], centroids: number[][]): void {
  for (let index = 0; index < centroids.length; index += 1) {
    const vectors = items.flatMap((item, itemIndex) => assignments[itemIndex] === index ? [item.vector] : []);
    if (vectors.length) centroids[index] = meanVector(vectors);
  }
}

function constrainedAssignments(items: VectorNote[], centroids: number[][], minimum: number, maximumShare: number): number[] {
  const assignments = new Array<number>(items.length).fill(-1);
  const counts = new Array<number>(centroids.length).fill(0);
  const capacity = Math.max(Math.ceil(items.length / centroids.length), Math.ceil(items.length * maximumShare));
  const assignBestUnassigned = (centroidIndex: number) => {
    const candidate = items.map((item, itemIndex) => ({ itemIndex, score: cosineSimilarity(item.vector, centroids[centroidIndex]!) }))
      .filter(({ itemIndex }) => assignments[itemIndex] === -1)
      .toSorted((left, right) => right.score - left.score || items[left.itemIndex]!.note.id.localeCompare(items[right.itemIndex]!.note.id))[0];
    if (candidate) { assignments[candidate.itemIndex] = centroidIndex; counts[centroidIndex] = (counts[centroidIndex] ?? 0) + 1; }
  };
  for (let round = 0; round < minimum; round += 1) centroids.forEach((_centroid, index) => assignBestUnassigned(index));
  const remaining = items.map((item, itemIndex) => ({
    itemIndex,
    confidence: Math.max(...centroids.map((centroid) => cosineSimilarity(item.vector, centroid))),
  })).filter(({ itemIndex }) => assignments[itemIndex] === -1).toSorted((left, right) => right.confidence - left.confidence || items[left.itemIndex]!.note.id.localeCompare(items[right.itemIndex]!.note.id));
  for (const { itemIndex } of remaining) {
    const choices = centroids.map((centroid, centroidIndex) => ({ centroidIndex, score: cosineSimilarity(items[itemIndex]!.vector, centroid) }))
      .filter(({ centroidIndex }) => (counts[centroidIndex] ?? 0) < capacity)
      .toSorted((left, right) => right.score - left.score || left.centroidIndex - right.centroidIndex);
    const selected = choices[0]?.centroidIndex ?? bestCentroid(items[itemIndex]!.vector, centroids);
    assignments[itemIndex] = selected;
    counts[selected] = (counts[selected] ?? 0) + 1;
  }
  return assignments;
}

function buildWorkLinks(themes: InternalTheme[], settings: GraphSettings): WorkRelationship[] {
  const byWork = new Map<string, InternalTheme[]>();
  for (const theme of themes) byWork.set(theme.workId, [...(byWork.get(theme.workId) ?? []), theme]);
  const workIds = [...byWork.keys()].sort();
  const candidates: WorkRelationship[] = [];
  for (let leftIndex = 0; leftIndex < workIds.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < workIds.length; rightIndex += 1) {
      const source = workIds[leftIndex]!;
      const target = workIds[rightIndex]!;
      const matches = distinctThemeMatches(byWork.get(source) ?? [], byWork.get(target) ?? [], settings);
      if (!matches.length) continue;
      candidates.push({ source, target, weight: matches.reduce((sum, match) => sum + match.similarity, 0) / matches.length, evidence: matches });
    }
  }
  const ranked = new Map<string, string[]>();
  for (const workId of workIds) {
    ranked.set(workId, candidates.filter((edge) => edge.source === workId || edge.target === workId)
      .toSorted((left, right) => right.weight - left.weight)
      .slice(0, settings.workNeighborCap)
      .map((edge) => edge.source === workId ? edge.target : edge.source));
  }
  return candidates.filter((edge) => ranked.get(edge.source)?.includes(edge.target) && ranked.get(edge.target)?.includes(edge.source));
}

function distinctThemeMatches(left: InternalTheme[], right: InternalTheme[], settings: GraphSettings): WorkRelationship["evidence"] {
  const candidates = left.flatMap((sourceTheme) => right.map((targetTheme) => ({
    sourceThemeId: sourceTheme.id,
    targetThemeId: targetTheme.id,
    sourceTheme: sourceTheme.label,
    targetTheme: targetTheme.label,
    similarity: cosineSimilarity(sourceTheme.centroid, targetTheme.centroid),
  }))).filter((match) => match.similarity >= settings.workSimilarityThreshold)
    .toSorted((a, b) => b.similarity - a.similarity || a.sourceThemeId.localeCompare(b.sourceThemeId));
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  const selected: typeof candidates = [];
  for (const candidate of candidates) {
    if (usedLeft.has(candidate.sourceThemeId) || usedRight.has(candidate.targetThemeId)) continue;
    selected.push(candidate);
    usedLeft.add(candidate.sourceThemeId);
    usedRight.add(candidate.targetThemeId);
    if (selected.length >= settings.themeMatchCap) break;
  }
  return selected;
}

function themeLabel(store: KnowledgeStore, members: VectorNote[], representative: NoteRecord): string {
  const counts = new Map<string, number>();
  for (const member of members) {
    for (const concept of store.conceptsForNote(member.note.id)) counts.set(concept.preferredLabel, (counts.get(concept.preferredLabel) ?? 0) + 1);
  }
  const concepts = [...counts].toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 2).map(([label]) => label);
  if (concepts.length) return concepts.join(" · ");
  const fallback = representative.coreIdea ?? representative.rawText;
  return fallback.length > 72 ? `${fallback.slice(0, 69)}…` : fallback;
}

function bestCentroid(vector: number[], centroids: number[][]): number {
  let best = 0;
  let score = -Infinity;
  centroids.forEach((centroid, index) => {
    const candidate = cosineSimilarity(vector, centroid);
    if (candidate > score) { score = candidate; best = index; }
  });
  return best;
}

function meanVector(vectors: number[][]): number[] {
  if (!vectors.length) return [];
  const mean = new Array<number>(vectors[0]?.length ?? 0).fill(0);
  for (const vector of vectors) vector.forEach((value, index) => { mean[index] = (mean[index] ?? 0) + value; });
  const norm = Math.sqrt(mean.reduce((sum, value) => sum + value * value, 0));
  return mean.map((value) => norm ? value / norm : 0);
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16)}`;
}

function integer(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.isFinite(value) ? Math.round(value!) : fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function decimal(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.isFinite(value) ? value! : fallback;
  return Math.round(Math.min(maximum, Math.max(minimum, parsed)) * 100) / 100;
}
