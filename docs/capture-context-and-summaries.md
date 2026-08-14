# Capture time, source context, grouping, and summaries

This document records the product decisions for offline captures that are uploaded later, book-aware processing, multi-image notes, later continuations, and source-level summaries.

## 1. Keep three different clocks

The application must never treat Telegram's send time as proven image capture time. Every capture should retain:

- `captured_at`: the best available estimate of when the original screenshot, photo, audio, or note was created. It may be unknown.
- `received_at`: when Telegram says the message was sent.
- `imported_at`: when the local application synchronized it.
- `captured_at_source`: `embedded_metadata`, `filename`, `user_supplied`, `telegram_sent_fallback`, or `unknown`.
- `captured_at_confidence`: `exact`, `derived`, `fallback`, or `unknown`.
- `timezone`: the timezone used to interpret a timestamp when one is available.

The timeline may fall back to `received_at`, but the interface must label that value as upload time rather than original capture time.

### What Telegram supplies

The Telegram Bot API defines `Message.date` as the time the message was sent. Its `PhotoSize` object exposes file identifiers, dimensions, and file size, but no original capture timestamp. A media album also supplies `media_group_id`, which is useful for grouping but not dating the original files.

Consequently, a screenshot sent through Telegram as a compressed **photo** must not be assumed to retain its original metadata. Sending it as a **file/document** gives the importer the original filename and a better chance to inspect unchanged embedded metadata, but this must be verified against sample files from the actual phone and Telegram client.

Recommended capture habit when chronology matters:

1. Send screenshots as files/documents where practical.
2. Keep original filenames.
3. Put related pages in one Telegram album or batch.
4. Optionally include a caption such as `book: Thinking in Systems | captured: 2026-08-10` when the original timestamp is important.

The importer will inspect embedded metadata and filename timestamps first. If neither exists, it will preserve the real value as unknown and use Telegram send time only as an explicitly marked display fallback.

## 2. Model a book separately from its captures

A book is a durable knowledge source; a screenshot is one piece of evidence captured from it. They should not be represented by the same record.

Add a `works` entity with fields such as:

- type (`book`, `article`, `lecture`, `conversation`, or another source type);
- title, author, edition, ISBN, language;
- optional user description, table of contents, and legally held local full-text path;
- creation and update timestamps.

Each capture points to a work. Notes point to their exact capture evidence and inherit the work context. Edition remains explicit because page numbers and wording can differ.

For Telegram, the first practical source-selection interface should support:

- a batch caption such as `book: Thinking in Systems`;
- mapping a Telegram topic/thread to one work;
- replying to an earlier capture to mark a continuation;
- a review action to reassign a capture if automatic routing is wrong.

An "active book" command can be added later, but it must be visible and expire safely so a forgotten state does not silently misfile subsequent notes.

## 3. Give the model context, not imaginary memory

The language model does not need to be retrained for each book, and its weights should not be treated as reliable memory of a particular edition. Every enrichment run should receive a bounded context packet containing:

- work title, author, edition, and user description;
- the OCR/transcript being processed;
- adjacent captures from the same candidate group;
- relevant reviewed notes already attached to the work;
- retrieved passages from a locally available full text, if one was explicitly imported.

The prompt must require the model to distinguish supplied evidence from inference and to abstain when context is missing. Fine-tuning is a later quality/style option based on reviewed examples; it is not the storage mechanism for book facts.

## 4. Group captures without irreversible guesses

One screenshot may contain several ideas, while several screenshots may form one note. Grouping therefore creates a reviewable candidate, not a destructive merge.

Signals, in descending order of reliability, are:

1. explicit user action: album, shared caption, reply/continuation marker, merge, split, or reorder;
2. same work and Telegram topic/thread;
3. `media_group_id` and Telegram message order;
4. embedded capture time and filename sequence;
5. OCR page numbers, sentence continuation, layout similarity, and semantic continuity;
6. proximity of Telegram send times as a weak fallback only.

The UI must allow merge, split, reorder, and reassignment while keeping every original asset immutable. A later upload can connect to an older note through a Telegram reply, an explicit `continues:` marker, or a manual graph/review action. Time proximity alone must never permanently join captures.

The processing stages should be idempotent and resumable:

```text
captured -> downloaded -> extracted -> grouped -> enriched -> reviewed -> linked -> summarized
```

Failures remain in a retry queue. Re-running a stage creates or updates a derived revision; it does not overwrite canonical OCR/transcript text or a previously generated result.

## 5. Build source-level summaries hierarchically

The product should support a versioned "summary of my captured notes from this source." It must not call that result a summary of the entire book unless the entire book was actually provided.

For a work with many notes:

1. summarize reviewed atomic notes in small, ordered/topic-based clusters;
2. retain citations from every cluster summary to notes, captures, and page numbers when available;
3. synthesize a work overview containing themes, important claims, tensions, personal takeaways, connections to other works, and open questions;
4. show coverage, for example the number of captured pages and notes, so incompleteness is visible;
5. when notes change, recompute affected clusters and then the overview rather than sending the entire corpus on every run.

Each summary revision records its input note revisions, model, prompt version, and creation time. The user can regenerate, compare, pin, or edit a summary without losing its provenance.

## Implementation sequence

### Phase A: metadata and work identity

- Migrate from the current single `captured_at` value to the three-clock model with provenance and confidence.
- Preserve Telegram reply/thread identifiers, original filename, document/photo transport type, album ID, and message order.
- Add `works` plus capture-to-work assignment.
- Add metadata inspection and tests using real phone samples sent once as a Telegram photo and once as a document.

### Phase B: reversible grouping

- Generate candidate groups using explicit Telegram structure first and heuristic signals second.
- Add merge, split, reorder, and attach-to-existing-note actions to the review interface.
- Display uncertain chronology and grouping decisions.

### Phase C: grounded book context

- Build the bounded work context packet and pass it to enrichment.
- Add local retrieval over reviewed notes and optional imported full text.
- Store prompt/model/input provenance for each run.

### Phase D: incremental work summaries

- Add cluster summaries and the versioned work overview.
- Add citations, coverage indicators, cross-work links, and stale-summary detection.

These phases should be implemented in this order. Phase A is the next schema/pipeline change because every later feature depends on correct identity and chronology.

The corresponding end-user interaction design is specified in [Telegram capture workflow](telegram-user-workflow.md).
