import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConceptMergeProposalRecord, ConceptRecord, ConceptSelection, EdgeRecord, EdgeType, Enrichment, EnrichmentContext, GraphExport, NoteConceptRecord, NoteRecord, SourceInput, SourceRecord, WorkInput, WorkRecord } from "./domain.js";
import { normalizeConceptLabel } from "./concepts.js";
import { cosineSimilarity, EMBEDDING_VERSION } from "./embeddings.js";
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
      CREATE TABLE IF NOT EXISTS concepts (
        id TEXT PRIMARY KEY,
        preferred_label TEXT NOT NULL,
        identity_key TEXT NOT NULL UNIQUE,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        definition TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        merged_into_id TEXT REFERENCES concepts(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS note_concepts (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        confidence REAL NOT NULL,
        evidence TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(note_id, concept_id)
      );
      CREATE TABLE IF NOT EXISTS concept_selection_runs (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        prompt_version TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(note_id, prompt_version)
      );
      CREATE TABLE IF NOT EXISTS note_embeddings (
        note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        representation_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(note_id, model, representation_version)
      );
      CREATE TABLE IF NOT EXISTS concept_embeddings (
        concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        representation_version TEXT NOT NULL,
        input_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(concept_id, model, representation_version)
      );
      CREATE TABLE IF NOT EXISTS concept_merge_proposals (
        id TEXT PRIMARY KEY,
        left_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        right_concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
        recommendation TEXT NOT NULL,
        confidence REAL NOT NULL,
        rationale TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'proposed',
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(left_concept_id, right_concept_id, prompt_version)
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
      CREATE INDEX IF NOT EXISTS idx_note_concepts_concept ON note_concepts(concept_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON note_embeddings(model, representation_version);
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
    this.db.prepare("DELETE FROM note_concepts WHERE note_id = ?").run(noteId);
    this.db.prepare("DELETE FROM concept_selection_runs WHERE note_id = ?").run(noteId);
    this.db.prepare("DELETE FROM note_embeddings WHERE note_id = ?").run(noteId);
  }

  enrichedNotes(): NoteRecord[] {
    return this.listNotes().filter((note) => note.status === "enriched" || note.status === "reviewed");
  }

  listConcepts(): ConceptRecord[] {
    return (this.db.prepare("SELECT * FROM concepts WHERE status = 'active' ORDER BY preferred_label").all() as Row[]).map((row) => this.mapConcept(row));
  }

  conceptsForNote(noteId: string): ConceptRecord[] {
    return (this.db.prepare(`
      SELECT concepts.* FROM note_concepts JOIN concepts ON concepts.id = note_concepts.concept_id
      WHERE note_concepts.note_id = ? AND concepts.status = 'active' ORDER BY concepts.preferred_label
    `).all(noteId) as Row[]).map((row) => this.mapConcept(row));
  }

  notesNeedingConcepts(promptVersion: string, limit = 100): NoteRecord[] {
    const rows = this.db.prepare(`
      SELECT notes.* FROM notes
      WHERE notes.status IN ('enriched', 'reviewed') AND NOT EXISTS (
        SELECT 1 FROM concept_selection_runs WHERE concept_selection_runs.note_id = notes.id AND concept_selection_runs.prompt_version = ?
      ) ORDER BY notes.created_at, notes.ordinal LIMIT ?
    `).all(promptVersion, limit) as Row[];
    return rows.map((row) => this.mapNote(row));
  }

  conceptCandidates(note: NoteRecord, limit = 5): ConceptRecord[] {
    const concepts = this.listConcepts();
    const tokens = new Set(normalizeConceptLabel(`${note.coreIdea ?? ""} ${note.context ?? ""} ${note.tags.join(" ")}`).split(" ").filter((token) => token.length > 2));
    const model = this.getSetting("embedding.model");
    const noteVector = model ? this.embedding(note.id, model)?.vector : undefined;
    return concepts.map((concept) => {
      const labels = normalizeConceptLabel(`${concept.preferredLabel} ${concept.aliases.join(" ")} ${concept.definition}`).split(" ");
      const lexical = labels.reduce((score, token) => score + (tokens.has(token) ? 1 : 0), 0);
      const conceptVector = model ? this.conceptEmbedding(concept.id, model)?.vector : undefined;
      const semantic = noteVector && conceptVector ? cosineSimilarity(noteVector, conceptVector) : 0;
      return { concept, lexical, semantic, score: semantic * 4 + Math.min(lexical, 3) * .2 };
    }).filter((candidate) => candidate.semantic >= .5 || candidate.lexical >= 2)
      .sort((left, right) => right.score - left.score || left.concept.preferredLabel.localeCompare(right.concept.preferredLabel)).slice(0, limit).map(({ concept }) => concept);
  }

  requeueConceptSelections(): number {
    const result = this.db.prepare("DELETE FROM concept_selection_runs").run();
    this.db.prepare("DELETE FROM note_concepts").run();
    return Number(result.changes);
  }

  replaceNoteConcepts(noteId: string, selection: ConceptSelection, model: string, promptVersion: string): number {
    const timestamp = now();
    const assignments = new Map<string, { confidence: number; evidence: string }>();
    for (const selected of selection.existing) {
      const exists = this.db.prepare("SELECT id FROM concepts WHERE id = ? AND status = 'active'").get(selected.conceptId);
      if (exists) assignments.set(selected.conceptId, { confidence: selected.confidence, evidence: selected.evidence });
    }
    for (const proposal of selection.proposed) {
      const identityKey = normalizeConceptLabel(proposal.preferredLabel);
      if (!identityKey) continue;
      const existing = this.db.prepare("SELECT * FROM concepts WHERE identity_key = ?").get(identityKey) as Row | undefined;
      const conceptId = existing ? String(existing.id) : randomUUID();
      if (!existing) this.db.prepare(`
        INSERT INTO concepts (id, preferred_label, identity_key, aliases_json, definition, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(conceptId, identityKey, identityKey, json(proposal.aliases.filter((alias) => normalizeConceptLabel(alias) !== identityKey)), proposal.definition, timestamp, timestamp);
      assignments.set(conceptId, { confidence: proposal.confidence, evidence: proposal.evidence });
    }
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM note_concepts WHERE note_id = ?").run(noteId);
      const insert = this.db.prepare(`
        INSERT INTO note_concepts (note_id, concept_id, confidence, evidence, model, prompt_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [conceptId, assignment] of assignments) insert.run(noteId, conceptId, assignment.confidence, assignment.evidence, model, promptVersion, timestamp);
      this.db.prepare(`INSERT OR REPLACE INTO concept_selection_runs (note_id, prompt_version, model, created_at) VALUES (?, ?, ?, ?)`)
        .run(noteId, promptVersion, model, timestamp);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return assignments.size;
  }

  embedding(noteId: string, model: string, representationVersion = EMBEDDING_VERSION): { inputHash: string; vector: number[] } | undefined {
    const row = this.db.prepare("SELECT input_hash, vector_json FROM note_embeddings WHERE note_id = ? AND model = ? AND representation_version = ?")
      .get(noteId, model, representationVersion) as Row | undefined;
    return row ? { inputHash: String(row.input_hash), vector: parseJson<number[]>(row.vector_json, []) } : undefined;
  }

  storeEmbedding(noteId: string, model: string, inputHash: string, vector: number[], representationVersion = EMBEDDING_VERSION): void {
    this.db.prepare(`
      INSERT INTO note_embeddings (note_id, model, representation_version, input_hash, dimensions, vector_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(note_id, model, representation_version) DO UPDATE SET input_hash = excluded.input_hash,
        dimensions = excluded.dimensions, vector_json = excluded.vector_json, created_at = excluded.created_at
    `).run(noteId, model, representationVersion, inputHash, vector.length, json(vector), now());
    this.setSetting("embedding.model", model);
  }

  conceptEmbedding(conceptId: string, model: string, representationVersion = EMBEDDING_VERSION): { inputHash: string; vector: number[] } | undefined {
    const row = this.db.prepare("SELECT input_hash, vector_json FROM concept_embeddings WHERE concept_id = ? AND model = ? AND representation_version = ?")
      .get(conceptId, model, representationVersion) as Row | undefined;
    return row ? { inputHash: String(row.input_hash), vector: parseJson<number[]>(row.vector_json, []) } : undefined;
  }

  storeConceptEmbedding(conceptId: string, model: string, inputHash: string, vector: number[], representationVersion = EMBEDDING_VERSION): void {
    this.db.prepare(`
      INSERT INTO concept_embeddings (concept_id, model, representation_version, input_hash, dimensions, vector_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(concept_id, model, representation_version) DO UPDATE SET input_hash = excluded.input_hash,
        dimensions = excluded.dimensions, vector_json = excluded.vector_json, created_at = excluded.created_at
    `).run(conceptId, model, representationVersion, inputHash, vector.length, json(vector), now());
  }

  conceptMaintenanceCandidates(model: string, limit = 20): Array<[ConceptRecord, ConceptRecord]> {
    const concepts = this.listConcepts();
    const embeddings = new Map<string, number[]>((this.db.prepare(`
      SELECT concept_id, vector_json FROM concept_embeddings WHERE model = ? AND representation_version = ?
    `).all(model, EMBEDDING_VERSION) as Row[]).map((row) => [String(row.concept_id), parseJson<number[]>(row.vector_json, [])]));
    const scored: Array<{ left: ConceptRecord; right: ConceptRecord; score: number }> = [];
    for (let leftIndex = 0; leftIndex < concepts.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < concepts.length; rightIndex += 1) {
        const left = concepts[leftIndex];
        const right = concepts[rightIndex];
        if (!left || !right) continue;
        const [firstId, secondId] = left.id.localeCompare(right.id) <= 0 ? [left.id, right.id] : [right.id, left.id];
        const existing = this.db.prepare(`SELECT 1 FROM concept_merge_proposals WHERE left_concept_id = ? AND right_concept_id = ?`).get(firstId, secondId);
        if (existing) continue;
        const leftTokens = new Set(normalizeConceptLabel(`${left.preferredLabel} ${left.aliases.join(" ")}`).split(" "));
        const rightTokens = new Set(normalizeConceptLabel(`${right.preferredLabel} ${right.aliases.join(" ")}`).split(" "));
        const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
        const lexicalScore = shared / Math.max(1, new Set([...leftTokens, ...rightTokens]).size);
        const leftVector = embeddings.get(left.id);
        const rightVector = embeddings.get(right.id);
        const semanticScore = leftVector && rightVector ? cosineSimilarity(leftVector, rightVector) : 0;
        const score = Math.max(lexicalScore, semanticScore);
        if (lexicalScore >= 0.25 || semanticScore >= 0.72) scored.push({ left, right, score });
      }
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(({ left, right }) => [left, right]);
  }

  addConceptMergeProposal(left: ConceptRecord, right: ConceptRecord, evaluation: { recommendation: string; confidence: number; rationale: string }, model: string, promptVersion: string): void {
    const [first, second] = left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left];
    this.db.prepare(`
      INSERT OR IGNORE INTO concept_merge_proposals
        (id, left_concept_id, right_concept_id, recommendation, confidence, rationale, status, model, prompt_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)
    `).run(randomUUID(), first.id, second.id, evaluation.recommendation, evaluation.confidence, evaluation.rationale, model, promptVersion, now());
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

  replaceDerivedEdges(options: { embeddingModel?: string; semanticTopK?: number; withinWorkThreshold?: number; crossWorkThreshold?: number } = {}): number {
    const notes = this.enrichedNotes();
    this.db.prepare("DELETE FROM edges WHERE type IN ('source_sequence', 'work_sequence', 'capture_sequence', 'explicit_reference', 'shared_tag', 'semantic_similarity')").run();
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
    const sourceRows = this.db.prepare("SELECT * FROM sources").all() as Row[];
    const sourceMetadata = new Map<string, Record<string, unknown>>(sourceRows.map((row) => [String(row.id), parseJson<Record<string, unknown>>(row.metadata_json, {})]));
    const sourceWork = new Map(sourceRows.map((row) => [String(row.id), row.work_id === null ? null : String(row.work_id)]));
    const sourceCapturedAt = new Map(sourceRows.map((row) => [String(row.id), String(row.captured_at)]));
    const workGroups = new Map<string, NoteRecord[]>();
    for (const note of notes) {
      const workId = sourceWork.get(note.sourceId);
      if (workId) workGroups.set(workId, [...(workGroups.get(workId) ?? []), note]);
    }
    for (const [workId, group] of workGroups) {
      group.sort((left, right) => sourceCapturedAt.get(left.sourceId)!.localeCompare(sourceCapturedAt.get(right.sourceId)!) || Number(sourceMetadata.get(left.sourceId)?.telegramMessageId ?? 0) - Number(sourceMetadata.get(right.sourceId)?.telegramMessageId ?? 0) || left.ordinal - right.ordinal);
      for (let index = 1; index < group.length; index += 1) {
        const left = group[index - 1];
        const right = group[index];
        if (!left || !right || left.sourceId === right.sourceId) continue;
        insert.run(randomUUID(), left.id, right.id, "work_sequence", 1, `Consecutive atomic notes within work ${workId}`, now());
        count += 1;
      }
    }
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
    const noteForSource = new Map(notes.map((note) => [note.sourceId, note]));
    for (const note of notes) {
      const groupSources = note.captureGroupId ? this.db.prepare("SELECT source_id FROM capture_group_sources WHERE capture_group_id = ?").all(note.captureGroupId) as Row[] : [];
      for (const row of groupSources) noteForSource.set(String(row.source_id), note);
    }
    const sourceByTelegramMessage = new Map<string, string>();
    for (const [sourceId, metadata] of sourceMetadata) {
      const chatId = metadata.telegramChatId;
      const messageId = metadata.telegramMessageId;
      if (chatId !== undefined && messageId !== undefined) sourceByTelegramMessage.set(`${chatId}:${messageId}`, sourceId);
    }
    for (const [sourceId, metadata] of sourceMetadata) {
      const replyId = metadata.telegramReplyToMessageId;
      if (replyId === undefined) continue;
      const targetSourceId = sourceByTelegramMessage.get(`${metadata.telegramChatId}:${replyId}`);
      const from = noteForSource.get(sourceId);
      const target = targetSourceId ? noteForSource.get(targetSourceId) : undefined;
      if (!from || !target || from.id === target.id) continue;
      insert.run(randomUUID(), from.id, target.id, "explicit_reference", 1, `Telegram reply to message ${replyId}`, now());
      count += 1;
    }
    const embeddingModel = options.embeddingModel ?? this.getSetting("embedding.model");
    if (embeddingModel) {
      const embeddings = new Map<string, number[]>((this.db.prepare(`
        SELECT note_id, vector_json FROM note_embeddings WHERE model = ? AND representation_version = ?
      `).all(embeddingModel, EMBEDDING_VERSION) as Row[]).map((row) => [String(row.note_id), parseJson<number[]>(row.vector_json, [])]));
      const topK = options.semanticTopK ?? 4;
      const ranked = new Map<string, Array<{ id: string; score: number }>>();
      for (const left of notes) {
        const leftVector = embeddings.get(left.id);
        if (!leftVector) continue;
        const matches: Array<{ id: string; score: number }> = [];
        for (const right of notes) {
          if (left.id === right.id) continue;
          const rightVector = embeddings.get(right.id);
          if (!rightVector) continue;
          const sameWork = sourceWork.get(left.sourceId) !== null && sourceWork.get(left.sourceId) === sourceWork.get(right.sourceId);
          const score = cosineSimilarity(leftVector, rightVector);
          const threshold = sameWork ? options.withinWorkThreshold ?? 0.42 : options.crossWorkThreshold ?? 0.52;
          if (score >= threshold) matches.push({ id: right.id, score });
        }
        ranked.set(left.id, matches.sort((a, b) => b.score - a.score).slice(0, topK));
      }
      const added = new Set<string>();
      for (const [leftId, matches] of ranked) {
        for (const match of matches) {
          if (!ranked.get(match.id)?.some((candidate) => candidate.id === leftId)) continue;
          const pair = [leftId, match.id].sort();
          const key = pair.join("\0");
          if (added.has(key) || !pair[0] || !pair[1]) continue;
          added.add(key);
          const reciprocal = ranked.get(match.id)?.find((candidate) => candidate.id === leftId)?.score ?? match.score;
          const score = (match.score + reciprocal) / 2;
          insert.run(randomUUID(), pair[0], pair[1], "semantic_similarity", score, `Mutual top-${topK} semantic similarity ${score.toFixed(3)} using ${embeddingModel}`, now());
          count += 1;
        }
      }
    }
    return count;
  }

  stats(): Record<string, number> {
    const getCount = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count);
    const result: Record<string, number> = { works: getCount("works"), sources: getCount("sources"), notes: getCount("notes"), concepts: getCount("concepts"), note_embeddings: getCount("note_embeddings"), concept_embeddings: getCount("concept_embeddings"), edges: getCount("edges") };
    const statuses = this.db.prepare("SELECT status, COUNT(*) AS count FROM notes GROUP BY status").all() as Row[];
    for (const row of statuses) result[`notes_${String(row.status)}`] = Number(row.count);
    return result;
  }

  exportGraph(): GraphExport {
    return {
      schemaVersion: 3,
      exportedAt: now(),
      works: this.listWorks(),
      sources: (this.db.prepare("SELECT * FROM sources ORDER BY created_at").all() as Row[]).map((row) => this.mapSource(row)),
      notes: this.listNotes(),
      concepts: this.listConcepts(),
      noteConcepts: (this.db.prepare("SELECT * FROM note_concepts ORDER BY created_at").all() as Row[]).map((row) => this.mapNoteConcept(row)),
      conceptMergeProposals: (this.db.prepare("SELECT * FROM concept_merge_proposals ORDER BY created_at").all() as Row[]).map((row) => this.mapConceptMergeProposal(row)),
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

  private mapConcept(row: Row): ConceptRecord {
    return {
      id: String(row.id), preferredLabel: String(row.preferred_label), aliases: parseJson<string[]>(row.aliases_json, []), definition: String(row.definition),
      status: String(row.status) as ConceptRecord["status"], mergedIntoId: row.merged_into_id === null ? null : String(row.merged_into_id),
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  private mapNoteConcept(row: Row): NoteConceptRecord {
    return {
      noteId: String(row.note_id), conceptId: String(row.concept_id), confidence: Number(row.confidence), evidence: String(row.evidence),
      model: String(row.model), promptVersion: String(row.prompt_version), createdAt: String(row.created_at),
    };
  }

  private mapConceptMergeProposal(row: Row): ConceptMergeProposalRecord {
    return {
      id: String(row.id), leftConceptId: String(row.left_concept_id), rightConceptId: String(row.right_concept_id),
      recommendation: String(row.recommendation) as ConceptMergeProposalRecord["recommendation"], confidence: Number(row.confidence), rationale: String(row.rationale),
      status: String(row.status) as ConceptMergeProposalRecord["status"], model: String(row.model), promptVersion: String(row.prompt_version), createdAt: String(row.created_at),
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
