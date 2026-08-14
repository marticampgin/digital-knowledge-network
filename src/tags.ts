export function normalizeTag(tag: string): string {
  return tag.trim().toLocaleLowerCase().replace(/_+/g, " ").replace(/\s+/g, " ");
}

export function normalizeTags(tags: string[], limit = 10): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))].slice(0, limit);
}
