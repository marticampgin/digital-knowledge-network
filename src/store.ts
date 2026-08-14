import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EdgeRecord, EdgeType, Enrichment, EnrichmentContext, GraphExport, NoteRecord, SourceInput, SourceRecord, WorkInput, WorkRecord } from "./domain.js";
import { normalizeTags } from "./tags.js";

type Row = Record<string, unknown>;

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value);
const parseJson = <T>(value: unknown, fallback: T): T => {
  try {
    return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

export class KnowledgeStore {
  private readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        author TEXT,
        edition TEXT,
        identifier TEXT,
        identity_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        origin TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        raw_content TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS capture_groups (
        id TEXT PRIMARY KEY,
        group_key TEXT NOT NULL UNIQUE,
        work_id TEXT REFERENCES works(id) ON DELETE SET NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        capture_group_id TEXT REFERENCES capture_groups(id) ON DELETE SET NULL,
        ordinal INTEGER NOT NULL,
        raw_text TEXT NOT NULL,
        core_idea TEXT,
        context TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL,
        status TEXT NOT NULL,
        model TEXT,
        prompt_version TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        weight REAL NOT NULL,
        evidence TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(from_note_id, to_note_id, type)
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_topic_works (
        chat_id TEXT NOT NULL,
        message_thread_id INTEGER NOT NULL,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, message_thread_id)
      );
      CREATE TABLE IF NOT EXISTS capture_group_sources (
        capture_group_id TEXT NOT NULL REFERENCES capture_groups(id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        PRIMARY KEY(capture_group_id, source_id),
        UNIQUE(source_id)
      );
      CREATE TABLE IF NOT EXISTS telegram_passage_sessions (
        chat_id TEXT NOT NULL,
        message_thread_id INTEGER NOT NULL,
        group_key TEXT NOT NULL,
        started_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, message_thread_id)
      );
      CREATE INDEX IF NOT EXISTS idx_notes_status ON notes(status);
      CREATE INDEX IF NOT EXISTS idx_notes_source ON notes(source_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_note_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_note_id);
    `);
    const sourceColumns = this.db.prepare("PRAGMA table_info(sources)").all() as Row[];
    if (!sourceColumns.some((column) => String(column.name) === "work_id")) {
      this.db.exec("ALTER TABLE sources ADD COLUMN work_id TEXT REFERENCES works(id) ON DELETE SET NULL");
    }
    const noteColumns = this.db.prepare("PRAGMA table_info(notes)").all() as Row[];
    if (!noteColumns.some((column) => String(column.name) === "capture_group_id")) {
      this.db.exec("ALTER TABLE notes ADD COLUMN capture_group_id TEXT REFERENCES capture_groups(id) ON DELETE SET NULL");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sources_work ON sources(work_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_notes_capture_group ON notes(capture_group_id)");
    const storedMetadata = this.db.prepare("SELECT id, kind, metadata_json FROM sources").all() as Row[];
    const updateMetadata = this.db.prepare("UPDATE sources SET metadata_json = ? WHERE id = ?");
    for (const row of storedMetadata) {
      const metadata = parseJson<Record<string, unknown>>(row.metadata_json, {});
      const hadBinaryReference = "blobPath" in metadata || "blobHash" in metadata;
      delete metadata.blobPath;
      delete metadata.blobHash;
      if (String(row.kind) === "image") metadata.canonicalEvidence = "ocr_text";
      if (String(row.kind) === "audio") metadata.canonicalEvidence = "transcript";
      if (hadBinaryReference || metadata.canonicalEvidence) updateMetadata.run(json(metadata), String(row.id));
    }
  }

  upsertWork(input: WorkInput): { work: WorkRecord; created: boolean } {
    const title = input.title.trim();
    if (!title) throw new Error("A work title is required");
    const author = cleanOptional(input.author);
    const edition = cleanOptional(input.edition);
    const identifier = cleanOptional(input.identifier);
    const identityKey = [input.kind, normalizeIdentity(title), normalizeIdentity(author ?? "")].join("\0");
    const existing = this.db.prepare("SELECT * FROM works WHERE identity_key = ?").get(identityKey) as Row | undefined;
    if (existing) return { work: this.mapWork(existing), created: false };
    const sameTitle = (this.db.prepare("SELECT * FROM works WHERE kind = ?").all(input.kind) as Row[])
      .find((row) => normalizeIdentity(String(row.title)) === normalizeIdentity(title));
    if (sameTitle && (!author || sameTitle.author === null)) {
      const updatedAuthor = sameTitle.author === null ? author : String(sameTitle.author);
      const updatedEdition = sameTitle.edition === null ? edition : String(sameTitle.edition);
      const updatedIdentifier = sameTitle.identifier === null ? identifier : String(sameTitle.identifier);
      const updatedIdentityKey = [input.kind, normalizeIdentity(title), normalizeIdentity(updatedAuthor ?? "")].join("\0");
      const timestamp = now();
      this.db.prepare(`
        UPDATE works SET author = ?, edition = ?, identifier = ?, identity_key = ?, updated_at = ? WHERE id = ?
      `).run(updatedAuthor, updatedEdition, updatedIdentifier, updatedIdentityKey, timestamp, String(sameTitle.id));
      const updated = this.db.prepare("SELECT * FROM works WHERE id = ?").get(String(sameTitle.id)) as Row;
      return { work: this.mapWork(updated), created: false };
    }
    const timestamp = now();
    const work: WorkRecord = { id: randomUUID(), kind: input.kind, title, author, edition, identifier, createdAt: timestamp, updatedAt: timestamp };
    this.db.prepare(`
      INSERT INTO works (id, kind, title, author, edition, identifier, identity_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(work.id, work.kind, work.title, work.author, work.edition, work.identifier, identityKey, work.createdAt, work.updatedAt);
    return { work, created: true };
  }

  bindTelegramTopic(chatId: number, messageThreadId: number, workId: string): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO telegram_topic_works (chat_id, message_thread_id, work_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, message_thread_id) DO UPDATE SET work_id = excluded.work_id, updated_at = excluded.updated_at
    `).run(String(chatId), messageThreadId, workId, timestamp, timestamp);
  }

  workForTelegramTopic(chatId: number, messageThreadId: number): WorkRecord | undefined {
    const row = this.db.prepare(`
      SELECT works.* FROM telegram_topic_works
      JOIN works ON works.id = telegram_topic_works.work_id
      WHERE telegram_topic_works.chat_id = ? AND telegram_topic_works.message_thread_id = ?
    `).get(String(chatId), messageThreadId) as Row | undefined;
    return row ? this.mapWork(row) : undefined;
  }

  listWorks(): WorkRecord[] {
    return (this.db.prepare("SELECT * FROM works ORDER BY created_at").all() as Row[]).map((row) => this.mapWork(row));
  }

  startTelegramPassage(chatId: number, messageThreadId: number, commandMessageId: number): string {
    if (this.activeTelegramPassage(chatId, messageThreadId)) throw new Error("A passage is already active in this topic; use /passage end first");
    const groupKey = `telegram:${chatId}:passage:${commandMessageId}`;
    this.db.prepare(`
      INSERT INTO telegram_passage_sessions (chat_id, message_thread_id, group_key, started_at) VALUES (?, ?, ?, ?)
    `).run(String(chatId), messageThreadId, groupKey, now());
    return groupKey;
  }

  continueTelegramPassage(chatId: number, messageThreadId: number, repliedToMessageId: number): string {
    if (this.activeTelegramPassage(chatId, messageThreadId)) throw new Error("A passage is already active in this topic; use /passage end first");
    const sourceRows = this.db.prepare("SELECT metadata_json FROM sources").all() as Row[];
    const metadata = sourceRows.map((row) => parseJson<Record<string, unknown>>(row.metadata_json, {})).find((value) =>
      Number(value.telegramChatId) === chatId && Number(value.telegramMessageId) === repliedToMessageId,
    );
    const groupKey = metadata?.captureGroupKey;
    if (typeof groupKey !== "string" || !groupKey) throw new Error("The replied-to message is not an imported capture");
    this.db.prepare(`
      INSERT INTO telegram_passage_sessions (chat_id, message_thread_id, group_key, started_at) VALUES (?, ?, ?, ?)
    `).run(String(chatId), messageThreadId, groupKey, now());
    return groupKey;
  }

  endTelegramPassage(chatId: number, messageThreadId: number): string {
    const active = this.activeTelegramPassage(chatId, messageThreadId);
    if (!active) throw new Error("No passage is active in this topic");
    this.db.prepare("DELETE FROM telegram_passage_sessions WHERE chat_id = ? AND message_thread_id = ?")
      .run(String(chatId), messageThreadId);
    return active;
  }

  activeTelegramPassage(chatId: number, messageThreadId: number): string | undefined {
    const row = this.db.prepare("SELECT group_key FROM telegram_passage_sessions WHERE chat_id = ? AND message_thread_id = ?")
      .get(String(chatId), messageThreadId) as Row | undefined;
    return row ? String(row.group_key) : undefined;
  }

  coalesceCaptureGroups(): { groups: number; notesRebuilt: number } {
    const sources = (this.db.prepare("SELECT * FROM sources ORDER BY created_at").all() as Row[]).map((row) => ({
      row,
      source: this.mapSource(row),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}),
    }));
    const candidates = new Map<string, typeof sources>();
    for (const item of sources) {
      const key = item.metadata.captureGroupKey;
      if (typeof key !== "string" || !key) continue;
      candidates.set(key, [...(candidates.get(key) ?? []), item]);
    }
    let groups = 0;
    let notesRebuilt = 0;
    for (const [groupKey, members] of candidates) {
      const explicitPassage = groupKey.includes(":passage:");
      if (!explicitPassage && members.length < 2) continue;
      members.sort((left, right) => Number(left.metadata.telegramMessageId ?? 0) - Number(right.metadata.telegramMessageId ?? 0));
      const timestamp = now();
      const existingGroup = this.db.prepare("SELECT * FROM capture_groups WHERE group_key = ?").get(groupKey) as Row | undefined;
      const groupId = existingGroup ? String(existingGroup.id) : randomUUID();
      const workId = members.find((member) => member.source.workId)?.source.workId ?? null;
      if (!existingGroup) {
        this.db.prepare(`INSERT INTO capture_groups (id, group_key, work_id, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(groupId, groupKey, workId, explicitPassage ? "passage" : "album", timestamp, timestamp);
      } else {
        this.db.prepare("UPDATE capture_groups SET work_id = ?, updated_at = ? WHERE id = ?").run(workId, timestamp, groupId);
      }
      const combined = members.map((member, index) =>
        `[CAPTURE ${index + 1} OF ${members.length} | TELEGRAM MESSAGE ${String(member.metadata.telegramMessageId ?? "UNKNOWN")}]\n${member.source.rawContent.trim()}`,
      ).join("\n\n");
      const primarySource = members[0]?.source;
      if (!primarySource) continue;
      const sourceIds = members.map((member) => member.source.id);
      const placeholders = sourceIds.map(() => "?").join(", ");
      const existingNote = this.db.prepare("SELECT * FROM notes WHERE capture_group_id = ?").get(groupId) as Row | undefined;
      this.db.exec("BEGIN");
      try {
        this.db.prepare("DELETE FROM capture_group_sources WHERE capture_group_id = ?").run(groupId);
        const insertMember = this.db.prepare("INSERT INTO capture_group_sources (capture_group_id, source_id, position) VALUES (?, ?, ?)");
        members.forEach((member, position) => insertMember.run(groupId, member.source.id, position));
        if (existingNote) {
          this.db.prepare(`DELETE FROM notes WHERE source_id IN (${placeholders}) AND id <> ?`).run(...sourceIds, String(existingNote.id));
          if (String(existingNote.raw_text) !== combined) {
            this.db.prepare(`
              UPDATE notes SET source_id = ?, raw_text = ?, core_idea = NULL, context = NULL, tags_json = '[]', confidence = NULL,
                status = 'extracted', model = NULL, prompt_version = NULL, updated_at = ? WHERE id = ?
            `).run(primarySource.id, combined, timestamp, String(existingNote.id));
            notesRebuilt += 1;
          }
        } else {
          this.db.prepare(`DELETE FROM notes WHERE source_id IN (${placeholders})`).run(...sourceIds);
          this.db.prepare(`
            INSERT INTO notes (id, source_id, capture_group_id, ordinal, raw_text, status, created_at, updated_at)
            VALUES (?, ?, ?, 0, ?, 'extracted', ?, ?)
          `).run(randomUUID(), primarySource.id, groupId, combined, timestamp, timestamp);
          notesRebuilt += 1;
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      groups += 1;
    }
    return { groups, notesRebuilt };
  }

  enrichmentContext(noteId: string): EnrichmentContext {
    const noteRow = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as Row | undefined;
    if (!noteRow) throw new Error(`Unknown note: ${noteId}`);
    const primarySource = this.db.prepare("SELECT * FROM sources WHERE id = ?").get(String(noteRow.source_id)) as Row;
    const workRow = primarySource.work_id === null ? undefined : this.db.prepare("SELECT * FROM works WHERE id = ?").get(String(primarySource.work_id)) as Row | undefined;
    const evidenceRows = noteRow.capture_group_id === null || noteRow.capture_group_id === undefined
      ? [primarySource]
      : this.db.prepare(`
          SELECT sources.* FROM capture_group_sources
          JOIN sources ON sources.id = capture_group_sources.source_id
          WHERE capture_group_sources.capture_group_id = ? ORDER BY capture_group_sources.position
        `).all(String(noteRow.capture_group_id)) as Row[];
    return {
      work: workRow ? this.mapWork(workRow) : null,
      evidenceCount: evidenceRows.length,
      sourceTitles: evidenceRows.map((row) => String(row.title)),
    };
  }

  addSource(input: SourceInput, atomicTexts: string[]): { source: SourceRecord; duplicate: boolean; noteCount: number } {
    const contentHash = createHash("sha256").update(`${input.kind}\0${input.rawContent}`).digest("hex");
    const existing = this.db.prepare("SELECT * FROM sources WHERE content_hash = ?").get(contentHash) as Row | undefined;
    if (existing) {
      if (input.workId && existing.work_id === null) {
        this.db.prepare("UPDATE sources SET work_id = ? WHERE id = ?").run(input.workId, String(existing.id));
        existing.work_id = input.workId;
      }
      const noteCount = Number((this.db.prepare("SELECT COUNT(*) AS count FROM notes WHERE source_id = ?").get(String(existing.id)) as Row).count);
      return { source: this.mapSource(existing), duplicate: true, noteCount };
    }

    const timestamp = now();
    const source: SourceRecord = {
      id: randomUUID(),
      workId: input.workId ?? null,
      kind: input.kind,
      title: input.title,
      origin: input.origin,
      rawContent: input.rawContent,
      capturedAt: input.capturedAt ?? timestamp,
      contentHash,
      metadata: input.metadata ?? {},
      createdAt: timestamp,
    };
    const insertSource = this.db.prepare(`
      INSERT INTO sources (id, work_id, kind, title, origin, captured_at, content_hash, raw_content, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertNote = this.db.prepare(`
      INSERT INTO notes (id, source_id, ordinal, raw_text, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'extracted', ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      insertSource.run(source.id, source.workId, source.kind, source.title, source.origin, source.capturedAt, source.contentHash, source.rawContent, json(source.metadata), source.createdAt);
      atomicTexts.forEach((text, ordinal) => insertNote.run(randomUUID(), source.id, ordinal, text, timestamp, timestamp));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { source, duplicate: false, noteCount: atomicTexts.length };
  }

  pendingNotes(limit = 100): NoteRecord[] {
    const rows = this.db.prepare("SELECT * FROM notes WHERE status IN ('extracted', 'failed') ORDER BY created_at, ordinal LIMIT ?").all(limit) as Row[];
    return rows.map((row) => this.mapNote(row));
  }

  requeueOutdatedNotes(promptVersion: string): number {
    const result = this.db.prepare(`
      UPDATE notes SET core_idea = NULL, context = NULL, tags_json = '[]', confidence = NULL, status = 'extracted',
        model = NULL, prompt_version = NULL, updated_at = ?
      WHERE status IN ('enriched', 'reviewed') AND (prompt_version IS NULL OR prompt_version <> ?)
    `).run(now(), promptVersion);
    return Number(result.changes);
  }

  enrichNote(noteId: string, enrichment: Enrichment, model: string, promptVersion: string): void {
    this.db.prepare(`
      UPDATE notes SET core_idea = ?, context = ?, tags_json = ?, confidence = ?, status = 'enriched', model = ?, prompt_version = ?, updated_at = ?
      WHERE id = ?
    `).run(enrichment.coreIdea, enrichment.context, json(normalizeTags(enrichment.tags)), enrichment.confidence, model, promptVersion, now(), noteId);
  }

  failNote(noteId: string): void {
    this.db.prepare("UPDATE notes SET status = 'failed', updated_at = ? WHERE id = ?").run(now(), noteId);
  }

  reviewNote(noteId: string): boolean {
    const result = this.db.prepare("UPDATE notes SET status = 'reviewed', updated_at = ? WHERE id = ? AND status = 'enriched'").run(now(), noteId);
    return result.changes > 0;
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, now());
  }

  replaceDerivedEdges(): number {
    const notes = this.listNotes().filter((note) => note.status === "enriched" || note.status === "reviewed");
    this.db.prepare("DELETE FROM edges WHERE type IN ('source_sequence', 'capture_sequence', 'shared_tag')").run();
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO edges (id, from_note_id, to_note_id, type, weight, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let count = 0;
    const ordered = new Map<string, NoteRecord[]>();
    for (const note of notes) ordered.set(note.sourceId, [...(ordered.get(note.sourceId) ?? []), note]);
    for (const group of ordered.values()) {
      group.sort((a, b) => a.ordinal - b.ordinal);
      for (let i = 1; i < group.length; i += 1) {
        const left = group[i - 1];
        const right = group[i];
        if (left && right) {
          insert.run(randomUUID(), left.id, right.id, "source_sequence", 1, "Adjacent atomic notes from the same source", now());
          count += 1;
        }
      }
    }
    const sourceMetadata = new Map<string, Record<string, unknown>>(
      (this.db.prepare("SELECT id, metadata_json FROM sources").all() as Row[]).map((row) => [
        String(row.id), parseJson<Record<string, unknown>>(row.metadata_json, {}),
      ]),
    );
    const captureGroups = new Map<string, NoteRecord[]>();
    for (const note of notes) {
      const metadata = sourceMetadata.get(note.sourceId);
      const groupKey = metadata?.telegramMediaGroupId;
      if (typeof groupKey !== "string" || !groupKey) continue;
      captureGroups.set(groupKey, [...(captureGroups.get(groupKey) ?? []), note]);
    }
    for (const [groupKey, group] of captureGroups) {
      group.sort((left, right) => {
        const leftMetadata = sourceMetadata.get(left.sourceId);
        const rightMetadata = sourceMetadata.get(right.sourceId);
        const messageDifference = Number(leftMetadata?.telegramMessageId ?? 0) - Number(rightMetadata?.telegramMessageId ?? 0);
        return messageDifference || left.ordinal - right.ordinal;
      });
      for (let index = 1; index < group.length; index += 1) {
        const left = group[index - 1];
        const right = group[index];
        if (!left || !right) continue;
        insert.run(randomUUID(), left.id, right.id, "capture_sequence", 1, `Consecutive pages in Telegram media group ${groupKey}`, now());
        count += 1;
      }
    }
    const notesById = new Map(notes.map((note) => [note.id, note]));
    const notesByTag = new Map<string, string[]>();
    for (const note of notes) {
      for (const tag of note.tags) notesByTag.set(tag, [...(notesByTag.get(tag) ?? []), note.id]);
    }
    const candidates = new Map<string, Set<string>>();
    for (const [tag, ids] of notesByTag) {
      for (let i = 0; i < ids.length; i += 1) {
        for (let j = i + 1; j < ids.length; j += 1) {
          const pair = [ids[i], ids[j]].filter((id): id is string => Boolean(id)).sort();
          if (pair.length !== 2) continue;
          const key = `${pair[0]}\0${pair[1]}`;
          const shared = candidates.get(key) ?? new Set<string>();
          shared.add(tag);
          candidates.set(key, shared);
        }
      }
    }
    const scoredCandidates: Array<{ left: NoteRecord; right: NoteRecord; shared: string[]; weight: number }> = [];
    for (const [key, sharedSet] of candidates) {
      const [leftId, rightId] = key.split("\0");
      const left = leftId ? notesById.get(leftId) : undefined;
      const right = rightId ? notesById.get(rightId) : undefined;
      if (!left || !right) continue;
      const shared = [...sharedSet];
      const weight = shared.length / new Set([...left.tags, ...right.tags]).size;
      if (weight >= 0.1) scoredCandidates.push({ left, right, shared, weight });
    }
    const semanticDegree = new Map<string, number>();
    scoredCandidates.sort((a, b) => b.weight - a.weight);
    for (const candidate of scoredCandidates) {
      if ((semanticDegree.get(candidate.left.id) ?? 0) >= 4 || (semanticDegree.get(candidate.right.id) ?? 0) >= 4) continue;
      insert.run(randomUUID(), candidate.left.id, candidate.right.id, "shared_tag", candidate.weight, `Shared tags: ${candidate.shared.join(", ")}`, now());
      semanticDegree.set(candidate.left.id, (semanticDegree.get(candidate.left.id) ?? 0) + 1);
      semanticDegree.set(candidate.right.id, (semanticDegree.get(candidate.right.id) ?? 0) + 1);
      count += 1;
    }
    return count;
  }

  stats(): Record<string, number> {
    const getCount = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count);
    const result: Record<string, number> = { works: getCount("works"), sources: getCount("sources"), notes: getCount("notes"), edges: getCount("edges") };
    const statuses = this.db.prepare("SELECT status, COUNT(*) AS count FROM notes GROUP BY status").all() as Row[];
    for (const row of statuses) result[`notes_${String(row.status)}`] = Number(row.count);
    return result;
  }

  exportGraph(): GraphExport {
    return {
      schemaVersion: 2,
      exportedAt: now(),
      works: this.listWorks(),
      sources: (this.db.prepare("SELECT * FROM sources ORDER BY created_at").all() as Row[]).map((row) => this.mapSource(row)),
      notes: this.listNotes(),
      edges: (this.db.prepare("SELECT * FROM edges ORDER BY created_at").all() as Row[]).map((row) => this.mapEdge(row)),
    };
  }

  private listNotes(): NoteRecord[] {
    return (this.db.prepare("SELECT * FROM notes ORDER BY created_at, ordinal").all() as Row[]).map((row) => this.mapNote(row));
  }

  private mapSource(row: Row): SourceRecord {
    return {
      id: String(row.id), kind: String(row.kind) as SourceRecord["kind"], title: String(row.title), origin: String(row.origin),
      workId: row.work_id === null || row.work_id === undefined ? null : String(row.work_id),
      capturedAt: String(row.captured_at), contentHash: String(row.content_hash), rawContent: String(row.raw_content),
      metadata: parseJson<Record<string, unknown>>(row.metadata_json, {}), createdAt: String(row.created_at),
    };
  }

  private mapNote(row: Row): NoteRecord {
    return {
      id: String(row.id), sourceId: String(row.source_id), captureGroupId: row.capture_group_id === null || row.capture_group_id === undefined ? null : String(row.capture_group_id), ordinal: Number(row.ordinal), rawText: String(row.raw_text),
      coreIdea: row.core_idea === null ? null : String(row.core_idea), context: row.context === null ? null : String(row.context),
      tags: normalizeTags(parseJson<string[]>(row.tags_json, [])), confidence: row.confidence === null ? null : Number(row.confidence),
      status: String(row.status) as NoteRecord["status"], model: row.model === null ? null : String(row.model),
      promptVersion: row.prompt_version === null ? null : String(row.prompt_version), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private mapEdge(row: Row): EdgeRecord {
    return {
      id: String(row.id), fromNoteId: String(row.from_note_id), toNoteId: String(row.to_note_id), type: String(row.type) as EdgeType,
      weight: Number(row.weight), evidence: String(row.evidence), createdAt: String(row.created_at),
    };
  }

  private mapWork(row: Row): WorkRecord {
    return {
      id: String(row.id), kind: String(row.kind) as WorkRecord["kind"], title: String(row.title),
      author: row.author === null ? null : String(row.author), edition: row.edition === null ? null : String(row.edition),
      identifier: row.identifier === null ? null : String(row.identifier), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }
}

function normalizeIdentity(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

function cleanOptional(value: string | undefined): string | null {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}
