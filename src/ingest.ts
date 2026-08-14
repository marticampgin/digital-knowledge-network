import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { SourceInput, SourceKind } from "./domain.js";

const supported = new Map<string, SourceKind>([[".txt", "text"], [".md", "markdown"], [".markdown", "markdown"]]);

export interface PreparedIngest {
  source: SourceInput;
  atomicTexts: string[];
}

export function prepareFile(filePath: string, title?: string): PreparedIngest {
  const absolute = resolve(filePath);
  if (!statSync(absolute).isFile()) throw new Error(`Not a file: ${absolute}`);
  const extension = extname(absolute).toLowerCase();
  const kind = supported.get(extension);
  if (!kind) throw new Error(`Unsupported file type '${extension}'. v0.1 accepts .txt, .md, and .markdown.`);
  const rawContent = readFileSync(absolute, "utf8").replace(/\r\n/g, "\n").trim();
  if (!rawContent) throw new Error(`File is empty: ${absolute}`);
  const atomicTexts = splitAtomicNotes(rawContent);
  return {
    source: { kind, title: title ?? basename(absolute, extension), origin: absolute, rawContent, metadata: { extension } },
    atomicTexts,
  };
}

export function splitAtomicNotes(content: string): string[] {
  const explicitBlocks = content.split(/^\s*---\s*$/m).map((part) => part.trim()).filter(Boolean);
  if (explicitBlocks.length > 1) return explicitBlocks;

  const headingStarts = [...content.matchAll(/^#{1,3}\s+.+$/gm)].map((match) => match.index ?? 0);
  if (headingStarts.length > 1) {
    return headingStarts.map((start, index) => content.slice(start, headingStarts[index + 1] ?? content.length).trim()).filter(Boolean);
  }
  return [content.trim()];
}

