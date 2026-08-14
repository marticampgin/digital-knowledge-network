import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { ExtractionOptions } from "./extractors.js";
import { extractFile } from "./extractors.js";
import { splitAtomicNotes } from "./ingest.js";
import { KnowledgeStore } from "./store.js";
import type { WorkInput, WorkKind } from "./domain.js";

interface TelegramChat { id: number; title?: string; username?: string; type: string }
interface TelegramFile { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
interface TelegramMessage {
  message_id: number; date: number; media_group_id?: string; text?: string; caption?: string; chat: TelegramChat;
  message_thread_id?: number; is_topic_message?: boolean; reply_to_message?: TelegramMessage;
  document?: TelegramFile; audio?: TelegramFile; voice?: TelegramFile; photo?: TelegramFile[];
}
interface TelegramUpdate { update_id: number; message?: TelegramMessage; channel_post?: TelegramMessage }
interface TelegramResponse<T> { ok: boolean; result: T; description?: string }

export interface TelegramChatSummary { id: number; title: string; type: string; pendingMessages: number }
export interface TelegramSyncResult {
  updates: number;
  imported: number;
  duplicates: number;
  commands: number;
  skipped: number;
  errors: string[];
  registeredSources: Array<{ messageId: number; threadId: number; workId: string; title: string; created: boolean }>;
  passageCommands: Array<{ messageId: number; threadId: number; action: PassageAction; groupKey: string }>;
  captureGroups: number;
  notesRebuilt: number;
}

export type PassageAction = "start" | "end" | "continue";

export class TelegramClient {
  constructor(private readonly token: string) {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  async discover(): Promise<TelegramChatSummary[]> {
    const updates = await this.updates();
    const chats = new Map<number, TelegramChatSummary>();
    for (const update of updates) {
      const message = update.message ?? update.channel_post;
      if (!message) continue;
      const current = chats.get(message.chat.id);
      chats.set(message.chat.id, {
        id: message.chat.id,
        title: message.chat.title ?? message.chat.username ?? `Chat ${message.chat.id}`,
        type: message.chat.type,
        pendingMessages: (current?.pendingMessages ?? 0) + 1,
      });
    }
    return [...chats.values()];
  }

  async sync(store: KnowledgeStore, chatId: number, options: ExtractionOptions = {}): Promise<TelegramSyncResult> {
    const savedOffset = store.getSetting("telegram.update_offset");
    const updates = await this.updates(savedOffset ? Number(savedOffset) : undefined);
    const result: TelegramSyncResult = {
      updates: updates.length, imported: 0, duplicates: 0, commands: 0, skipped: 0, errors: [],
      registeredSources: [], passageCommands: [], captureGroups: 0, notesRebuilt: 0,
    };
    let nextOffset = savedOffset ? Number(savedOffset) : 0;
    for (const update of updates) {
      nextOffset = Math.max(nextOffset, update.update_id + 1);
      const message = update.message ?? update.channel_post;
      if (!message || message.chat.id !== chatId) continue;
      try {
        const imported = await this.importMessage(store, message, options);
        if (imported.status === "imported") result.imported += 1;
        else if (imported.status === "duplicate") result.duplicates += 1;
        else if (imported.status === "command") {
          result.commands += 1;
          if (imported.registration) result.registeredSources.push(imported.registration);
          if (imported.passage) result.passageCommands.push(imported.passage);
        } else result.skipped += 1;
      } catch (error) {
        result.errors.push(`Message ${message.message_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (nextOffset > 0) store.setSetting("telegram.update_offset", String(nextOffset));
    store.setSetting("telegram.chat_id", String(chatId));
    const grouped = store.coalesceCaptureGroups();
    result.captureGroups = grouped.groups;
    result.notesRebuilt = grouped.notesRebuilt;
    return result;
  }

  private async updates(offset?: number): Promise<TelegramUpdate[]> {
    const query = new URLSearchParams({ timeout: "0", limit: "100", allowed_updates: JSON.stringify(["message", "channel_post"]) });
    if (offset !== undefined) query.set("offset", String(offset));
    return this.call<TelegramUpdate[]>(`getUpdates?${query}`);
  }

  private async importMessage(store: KnowledgeStore, message: TelegramMessage, options: ExtractionOptions): Promise<
    { status: "imported" | "duplicate" | "skipped" } |
    { status: "command"; registration?: { messageId: number; threadId: number; workId: string; title: string; created: boolean }; passage?: { messageId: number; threadId: number; action: PassageAction; groupKey: string } }
  > {
    const sourceCommand = parseSourceCommand(message.text);
    if (sourceCommand) {
      if (message.message_thread_id === undefined) throw new Error("/source must be sent inside a Telegram topic");
      const registered = store.upsertWork(sourceCommand);
      store.bindTelegramTopic(message.chat.id, message.message_thread_id, registered.work.id);
      return {
        status: "command",
        registration: {
          messageId: message.message_id,
          threadId: message.message_thread_id,
          workId: registered.work.id,
          title: registered.work.title,
          created: registered.created,
        },
      };
    }
    const passageCommand = parsePassageCommand(message.text);
    if (passageCommand) {
      if (message.message_thread_id === undefined) throw new Error("/passage commands must be sent inside a Telegram topic");
      let groupKey: string;
      if (passageCommand === "start") {
        groupKey = store.startTelegramPassage(message.chat.id, message.message_thread_id, message.message_id);
      } else if (passageCommand === "end") {
        groupKey = store.endTelegramPassage(message.chat.id, message.message_thread_id);
      } else {
        const repliedTo = message.reply_to_message?.message_id;
        if (repliedTo === undefined) throw new Error("/passage continue must reply to an imported message from the passage");
        groupKey = store.continueTelegramPassage(message.chat.id, message.message_thread_id, repliedTo);
      }
      return { status: "command", passage: { messageId: message.message_id, threadId: message.message_thread_id, action: passageCommand, groupKey } };
    }
    if (message.text?.trim().toLocaleLowerCase() === "dkn connection test") return { status: "skipped" };
    const work = message.message_thread_id === undefined ? undefined : store.workForTelegramTopic(message.chat.id, message.message_thread_id);
    const activePassage = message.message_thread_id === undefined ? undefined : store.activeTelegramPassage(message.chat.id, message.message_thread_id);
    const receivedAt = new Date(message.date * 1000).toISOString();
    const importedAt = new Date().toISOString();
    const baseMetadata = {
      telegramChatId: message.chat.id,
      telegramMessageId: message.message_id,
      telegramMessageThreadId: message.message_thread_id,
      telegramIsTopicMessage: message.is_topic_message ?? false,
      telegramReplyToMessageId: message.reply_to_message?.message_id,
      telegramMediaGroupId: message.media_group_id,
      telegramDate: receivedAt,
      receivedAt,
      importedAt,
      capturedAtSource: "telegram_sent_fallback",
      capturedAtConfidence: "fallback",
      captureGroupKey: activePassage ?? (message.media_group_id
        ? `telegram:${message.chat.id}:album:${message.media_group_id}`
        : `telegram:${message.chat.id}:message:${message.message_id}`),
      caption: message.caption,
    };
    if (message.text?.trim()) {
      const source = {
        kind: "telegram" as const,
        title: work ? `${work.title} — Telegram ${message.message_id}` : message.text.trim().split("\n", 1)[0]?.slice(0, 80) || `Telegram ${message.message_id}`,
        origin: `telegram://${message.chat.id}/${message.message_id}`,
        rawContent: message.text.trim(),
        workId: work?.id,
        capturedAt: receivedAt,
        metadata: baseMetadata,
      };
      const added = store.addSource(source, splitAtomicNotes(source.rawContent));
      return { status: added.duplicate ? "duplicate" : "imported" };
    }

    const media = chooseMedia(message);
    if (!media) return { status: "skipped" };
    if ((media.file.file_size ?? 0) > 20 * 1024 * 1024) throw new Error("File exceeds Telegram Bot API's 20 MB download limit");
    const fileInfo = await this.call<{ file_path?: string }>(`getFile?file_id=${encodeURIComponent(media.file.file_id)}`);
    if (!fileInfo.file_path) throw new Error("Telegram did not return a file path");
    const extension = extensionFor(media, fileInfo.file_path);
    const temporary = resolve(options.dataDir ?? ".dkn", "tmp", "telegram");
    mkdirSync(temporary, { recursive: true });
    const localPath = resolve(temporary, `${message.chat.id}-${message.message_id}${extension}`);
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${fileInfo.file_path}`);
    if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
    writeFileSync(localPath, Buffer.from(await response.arrayBuffer()));
    try {
      const extracted = await extractFile(localPath, message.caption ?? media.file.file_name ?? (work ? `${work.title} — Telegram ${message.message_id}` : `Telegram ${message.message_id}`), options);
      extracted.source.origin = `telegram://${message.chat.id}/${message.message_id}`;
      extracted.source.workId = work?.id;
      extracted.source.capturedAt = receivedAt;
      extracted.source.metadata = {
        ...extracted.source.metadata,
        ...baseMetadata,
        telegramFileId: media.file.file_id,
        telegramTransportType: media.type,
        telegramOriginalFileName: media.file.file_name,
        telegramMimeType: media.file.mime_type,
        telegramFileSize: media.file.file_size,
      };
      const added = store.addSource(extracted.source, extracted.atomicTexts);
      return { status: added.duplicate ? "duplicate" : "imported" };
    } finally {
      if (existsSync(localPath)) rmSync(localPath);
    }
  }

  private async call<T>(method: string): Promise<T> {
    const response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`);
    const body = await response.json() as TelegramResponse<T>;
    if (!response.ok || !body.ok) throw new Error(body.description ?? `Telegram API failed: ${response.status}`);
    return body.result;
  }
}

export function parsePassageCommand(text: string | undefined): PassageAction | undefined {
  if (!text) return undefined;
  const match = text.trim().match(/^\/passage(?:@[a-zA-Z0-9_]+)?\s+(start|end|continue)\s*$/i);
  return match?.[1]?.toLocaleLowerCase() as PassageAction | undefined;
}

export function parseSourceCommand(text: string | undefined): WorkInput | undefined {
  if (!text) return undefined;
  const match = text.trim().match(/^\/source(?:@[a-zA-Z0-9_]+)?\s+(.+)$/i);
  if (!match?.[1]) return undefined;
  const parts = match[1].split("|").map((part) => part.trim());
  const rawKind = parts[0]?.toLocaleLowerCase();
  const kindAliases: Record<string, WorkKind> = {
    book: "book", article: "article", website: "website", web: "website",
    audio: "audio_video", video: "audio_video", audio_video: "audio_video", other: "other",
  };
  const kind = rawKind ? kindAliases[rawKind] : undefined;
  if (!kind) throw new Error("/source kind must be book, article, website, audio, video, or other");
  const title = parts[1];
  if (!title) throw new Error("Use /source kind | Exact title | Optional author");
  const rawAuthor = parts[2];
  const author = rawAuthor && !/^(author|author name)$/i.test(rawAuthor) ? rawAuthor : undefined;
  return { kind, title, author, edition: parts[3] || undefined, identifier: parts[4] || undefined };
}

function chooseMedia(message: TelegramMessage): { type: "image" | "audio" | "document"; file: TelegramFile } | undefined {
  const photo = message.photo?.at(-1);
  if (photo) return { type: "image", file: photo };
  if (message.voice) return { type: "audio", file: message.voice };
  if (message.audio) return { type: "audio", file: message.audio };
  if (message.document) return { type: "document", file: message.document };
  return undefined;
}

function extensionFor(media: { type: string; file: TelegramFile }, telegramPath: string): string {
  const named = extname(media.file.file_name ?? telegramPath);
  if (named) return named.toLowerCase();
  if (media.type === "image") return ".jpg";
  if (media.file.mime_type === "audio/ogg") return ".ogg";
  return media.type === "audio" ? ".mp3" : ".bin";
}
