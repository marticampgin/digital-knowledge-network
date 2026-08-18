# Telegram capture workflow

This is the intended user experience for capturing unrelated notes, book excerpts, article screenshots, text, and audio without turning Telegram into a data-entry form.

## The three concepts the interface keeps separate

1. **Source/work:** where material came from, such as a book, article, website, lecture, or conversation.
2. **Capture group:** the screenshots, text, and audio that belong together as one captured passage or thought.
3. **Knowledge notes:** one or more atomic ideas extracted from a capture group.

Several uploads can share a source without forming one note. Conversely, several screenshots can form one passage. The system must not infer one relationship merely from the other.

## Recommended Telegram structure

Use a private Telegram supergroup with **Topics** enabled. Give the bot permission to manage topics.

- **General / Unassigned:** quick, unrelated, or currently unidentified material.
- **One topic per durable source:** for example `Thinking in Systems - Donella Meadows` or `Article - How Complex Systems Fail`.

The topic is the default source assignment. It remains valid when more notes from the same book are uploaded days or months later. There is no global "current book" state that can be accidentally left active.

The Telegram Bot API exposes `message_thread_id`, and an appropriately permitted bot can create forum topics. The first implementation can let the user create topics manually; the polished flow lets the bot create and register them.

## Everyday workflows

### A quick unrelated thought

1. Send text, a screenshot, or a voice message to **General**.
2. The system imports it with source `Unknown` unless the message contains an explicit URL or source assignment.
3. OCR/transcription and atomic-note extraction still run normally.
4. Later, the source may be assigned explicitly. A source is not required for a useful personal thought.

### Starting notes for a new book

1. In the group, run `/source`.
2. The bot presents `Book`, `Article/website`, `Audio/video`, and `Other` buttons.
3. For a book, enter at least the title. Author, edition/year, ISBN, and optional context can be added immediately or later.
4. The bot searches existing local works for a likely match. If none is confirmed, it creates the work and a dedicated Telegram topic.
5. Upload future screenshots, text comments, and voice reflections inside that topic. They automatically inherit the book identity.

The currently implemented one-line form is:

```text
/source book | Exact Book Title | Optional Author | Optional Edition | Optional ISBN
```

Sending the command again with missing author, edition, or identifier fields completed updates the existing same-title work rather than creating a duplicate.

Example source card:

```text
BOOK
Thinking in Systems
Donella H. Meadows - 2008 edition

[Open topic] [Edit metadata] [Merge duplicate]
```

Creating the source before uploading is preferred because it gives immediate, deterministic routing. It is not mandatory.

### Starting notes for an article or website

The best input is the URL, not a screenshot alone:

1. Paste the article URL into **General** or run `/source` and choose `Article/website`.
2. The importer stores the supplied URL and, when network lookup is enabled, retrieves the page's canonical URL, title, author, and publication date for confirmation.
3. The bot creates or reuses a source topic.
4. Put screenshots or commentary in that topic.

If only a screenshot is available, it remains `Unknown` until the user assigns it. OCR text is not used to guess its source.

### Uploading a multi-page passage

1. Open the appropriate source topic.
2. Select the related screenshots together and send them as one Telegram album when possible.
3. Telegram album order becomes the initial page order.
4. The album becomes one capture group and produces exactly one atomic note from the complete ordered passage.
5. Every screenshot's unchanged OCR result remains source evidence and is combined for enrichment. The screenshot file itself is deleted after OCR.

Screenshots sent as separate messages are separate capture groups by default. Time proximity can trigger a `Possibly related` suggestion, but cannot silently merge them.

For a passage longer than Telegram's ten-item album limit:

```text
/passage start
```

Upload any number of albums, separate screenshots, text, or audio, then close it with:

```text
/passage end
```

Everything between the commands forms one ordered capture group and exactly one atomic note.

### Continuing an older passage later

Inside the same source topic:

1. Reply to an earlier screenshot, capture receipt, or note card with the new material.
2. Reply with `/passage continue`.
3. Upload the additional evidence, then send `/passage end`.

This reopens the existing group even when the continuation occurs weeks afterward.

## If the source was not provided first

Nothing is lost. Uploads remain unassigned. The user can assign them afterward in either of these ways:

- reply to an individual message or album with `/assign`, then select/create a source;
- select several captures in the application and use a future `Assign source` action;
- explicitly supply a URL or select an existing source.

An assignment applies only to the explicitly selected message, album, or reply chain. It does not automatically sweep in neighboring messages merely because their send times are close.

## Source assignment policy

Source identity is command-driven and deterministic. It comes only from:

1. the registered source topic;
2. an explicit `/source` or `/assign` action;
3. an attached/shared URL, DOI, ISBN, or other identifier deliberately supplied by the user;
4. a reply to a capture that already has an assigned source.

OCR, similarity, and model knowledge do not guess or suggest a source. A plain quotation is not enough to identify a book reliably, so `Unknown` is a valid permanent state. Network lookup may fill bibliographic fields for an explicitly supplied URL, DOI, or ISBN, but it does not decide the source from note content.

## Minimal commands

The Telegram interface should remain button-led. Commands provide fast and accessible equivalents:

- `/source` - select or create a source and optionally create its topic;
- `/passage start` - begin one atomic note that may span any number of uploads;
- `/passage end` - close the active passage;
- `/passage continue` - when sent as a reply, reopen an existing passage for additional evidence;
- `/assign` - when sent as a reply, assign that message/album to a source;
- `/unknown` - deliberately leave the selected material without a source;
- `/status` - show pending, processed, uncertain, and failed captures;
- `/summary` - planned Telegram shortcut; today use `npm run summarize -- "Exact Work Title"` locally;
- `/help` - show examples and buttons.

There should be no requirement to type special metadata into every caption. For advanced use, a compact caption directive may override defaults:

```text
dkn: pages=117-119; captured=2026-08-10; group=one-passage
```

Ordinary caption text remains a user note and is never discarded as metadata.

## Bot feedback without chat clutter

The bot should acknowledge a completed album or synchronization batch with one compact receipt, not reply to every image:

```text
Imported 4 screenshots -> Thinking in Systems
Capture time: unknown; upload time: Aug 14, 18:42
Grouping: one atomic passage

[Correct source] [Split] [Reorder] [Review]
```

Uncertainty is surfaced at the point where the user can fix it. Routine successful captures can use a reaction or a single batch receipt.

## Default decisions

- Source topic determines source; General means unassigned.
- Telegram album means one ordered capture group and one atomic note.
- Separate messages remain separate unless enclosed by passage commands.
- Replies express continuation more strongly than timestamps.
- User attribution outranks OCR and model inference.
- Unknown is preferable to a fabricated source.
- Source assignment, grouping, extraction, and summaries are all editable and versioned.
