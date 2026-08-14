import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { promisify } from "node:util";
import { createWorker } from "tesseract.js";
import type { SourceInput, SourceKind } from "./domain.js";
import { prepareFile, splitAtomicNotes } from "./ingest.js";

const execFileAsync = promisify(execFile);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".ogg", ".oga", ".opus", ".m4a", ".aac", ".flac"]);

export interface ExtractedFile {
  source: SourceInput;
  atomicTexts: string[];
}

export interface ExtractionOptions {
  dataDir?: string;
  ocrLangPath?: string;
  whisperCli?: string;
  whisperModel?: string;
  ffmpeg?: string;
}

export async function extractFile(filePath: string, title?: string, options: ExtractionOptions = {}): Promise<ExtractedFile> {
  const absolute = resolve(filePath);
  if (!statSync(absolute).isFile()) throw new Error(`Not a file: ${absolute}`);
  const extension = extname(absolute).toLowerCase();
  const dataDir = resolve(options.dataDir ?? ".dkn");

  if ([".txt", ".md", ".markdown"].includes(extension)) {
    return prepareFile(absolute, title);
  }
  if (IMAGE_EXTENSIONS.has(extension)) {
    const result = await recognizeImage(absolute, options.ocrLangPath, dataDir);
    if (!result.text.trim()) throw new Error("OCR produced no text. Keep the image and retry with a different OCR adapter or crop.");
    return mediaResult("image", absolute, title, result.text, {
      extractor: "tesseract.js:eng",
      extractionConfidence: result.confidence / 100,
    });
  }
  if (AUDIO_EXTENSIONS.has(extension)) {
    const text = await transcribeAudio(absolute, dataDir, options);
    if (!text.trim()) throw new Error("Speech transcription produced no text.");
    return mediaResult("audio", absolute, title, text, { extractor: "whisper.cpp:base.en" });
  }
  throw new Error(`Unsupported file type '${extension}'. Supported: text, Markdown, common images, and common audio.`);
}

async function recognizeImage(filePath: string, configuredLangPath: string | undefined, dataDir: string): Promise<{ text: string; confidence: number }> {
  const langPath = resolve(configuredLangPath ?? "node_modules/@tesseract.js-data/eng/4.0.0_best_int");
  const cachePath = resolve(dataDir, "ocr-cache");
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker("eng", 1, { langPath, cachePath, gzip: true });
  try {
    const { data } = await worker.recognize(filePath);
    return { text: data.text.replace(/\r\n/g, "\n").trim(), confidence: data.confidence };
  } finally {
    await worker.terminate();
  }
}

async function transcribeAudio(filePath: string, dataDir: string, options: ExtractionOptions): Promise<string> {
  const whisperCli = resolve(options.whisperCli ?? `${dataDir}/tools/whisper.cpp/Release/whisper-cli.exe`);
  const whisperModel = resolve(options.whisperModel ?? `${dataDir}/models/whisper/ggml-base.en.bin`);
  if (!existsSync(whisperCli)) throw new Error(`Whisper runtime not found: ${whisperCli}. Run npm run models:setup.`);
  if (!existsSync(whisperModel)) throw new Error(`Whisper model not found: ${whisperModel}. Run npm run models:setup.`);

  const tempDir = resolve(dataDir, "tmp");
  mkdirSync(tempDir, { recursive: true });
  const prefix = resolve(tempDir, `whisper-${randomUUID()}`);
  let input = filePath;
  let converted: string | undefined;
  if (![".wav", ".mp3", ".ogg", ".flac"].includes(extname(filePath).toLowerCase())) {
    converted = `${prefix}.wav`;
    await execFileAsync(options.ffmpeg ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", filePath, "-ar", "16000", "-ac", "1", converted]);
    input = converted;
  }
  try {
    await execFileAsync(whisperCli, ["-m", whisperModel, "-f", input, "-l", "en", "-t", "6", "-otxt", "-of", prefix, "-nt", "-np"], {
      cwd: resolve(whisperCli, ".."),
      maxBuffer: 10 * 1024 * 1024,
    });
    return readFileSync(`${prefix}.txt`, "utf8").replace(/\r\n/g, "\n").trim();
  } finally {
    for (const path of [`${prefix}.txt`, converted]) if (path && existsSync(path)) rmSync(path);
  }
}

function mediaResult(kind: SourceKind, filePath: string, title: string | undefined, rawContent: string, metadata: Record<string, unknown>): ExtractedFile {
  return {
    source: {
      kind,
      title: title ?? basename(filePath, extname(filePath)),
      origin: filePath,
      rawContent,
      metadata: { ...metadata, originalExtension: extname(filePath).toLowerCase(), canonicalEvidence: kind === "image" ? "ocr_text" : "transcript" },
    },
    atomicTexts: splitAtomicNotes(rawContent),
  };
}
