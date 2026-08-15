# Technical overview

Digital Knowledge Network is a local-first TypeScript application that converts captured material into auditable atomic notes and a derived knowledge graph. Its central design rule is separation: canonical evidence is stored unchanged, while every generated interpretation remains visibly and structurally distinct.

## System shape

```text
Telegram or file upload
        -> media extraction
        -> canonical text evidence
        -> capture grouping / atomic note
        -> local LLM enrichment
        -> typed graph derivation
        -> web explorer and JSON export
```

The project is a single Node.js codebase with a React frontend. It avoids a separate graph database or cloud backend at this stage, keeping deployment and private-data handling simple.

## Technology stack

- **Runtime and language:** Node.js 22.13+ with strict TypeScript and native ES modules.
- **Backend:** Fastify 5 provides the local HTTP API, multipart uploads, and production static-file serving.
- **Frontend:** React 19 and Vite 7. The interface is a responsive single-page application; `react-force-graph-2d` renders the interactive canvas and Lucide supplies icons.
- **Persistence:** Node's built-in SQLite interface stores works, sources, capture groups, notes, edges, Telegram cursors, and model/prompt provenance in `.dkn/knowledge.sqlite`.
- **OCR:** Tesseract.js 7 with packaged English language data. The OCR result—not the uploaded screenshot—is retained as canonical evidence.
- **Speech-to-text:** a pinned local `whisper.cpp` runtime with the English `base.en` model. FFmpeg converts formats when required. The transcript is retained; temporary audio is removed.
- **Language model:** LFM2.5-2.6B runs outside the application behind an OpenAI-compatible `/chat/completions` endpoint. On Windows, the pinned `llama.cpp` Vulkan runtime detects the installed GPU and offloads all model layers to VRAM. The adapter can target another compatible runtime without changing domain logic.
- **Quality tooling:** Vitest covers the data and ingestion pipeline; TypeScript performs static checks; Playwright supports browser-level UI verification.

## Data and processing model

A **work** is the human-supplied identity of a book, article, website, or other durable source. A **source** is one captured input plus provenance, such as a Telegram message or OCR result. A **capture group** orders several sources that form one passage. A **note** stores canonical text separately from LLM-generated `coreIdea`, `context`, `tags`, and confidence. An **edge** is a typed, weighted relationship with human-readable evidence.

Telegram topics bind deterministically to works through `/source`; content is never used to guess a title. Albums share a Telegram media-group key and coalesce into one ordered note. `/passage start`, `/passage end`, and reply-based `/passage continue` provide explicit grouping beyond Telegram's ten-item album limit. Content hashes and a stored Telegram update cursor make synchronization incremental and idempotent.

Extraction is adapter-based by file type. Text and Markdown are read directly; images go through Tesseract; audio goes through Whisper. Media downloads are written only to `.dkn/tmp` and deleted in `finally` cleanup after extraction. The resulting canonical text is the input to segmentation and enrichment.

## Enrichment and graph construction

The generative model is shared infrastructure, not one undifferentiated agent. Three independent, versioned tasks call the same local OpenAI-compatible endpoint at temperature `0`, each with its own system prompt and strict JSON schema:

- `atomic-note-enrichment` (`atomic-passage-v3`) produces the faithful core idea, context, descriptive tags, and confidence from canonical evidence;
- `concept-selection` (`concept-selection-v4`) assigns exactly one primary controlled concept: it accepts the single retrieved candidate when it directly fits, otherwise it proposes one new concept;
- `concept-maintenance` (`concept-maintenance-v1`) evaluates semantically similar concept pairs as merge, alias, or keep-separate proposals. It cannot assign concepts to notes or silently change the registry.

The model, prompt version, confidence, and evidence are stored with derived records. Structured responses are repaired and retried when necessary; a note is not marked complete until it has one valid primary concept.

`Xenova/all-MiniLM-L6-v2` runs locally through Transformers.js and produces normalized 384-dimensional embeddings. The model is small, English-focused, and intended for sentence/paragraph semantic similarity. Model files are cached under `.dkn/models/transformers`; note and concept vectors are keyed by model, representation version, and input hash so unchanged material is not recomputed.

Graph edges are rebuilt from two explicitly separated layers:

- `source_sequence` connects adjacent atomic notes from the same captured source;
- `work_sequence` connects adjacent atomic notes within the same registered book, article, audio work, or other source container;
- `capture_sequence` preserves order when a capture group contains separate notes;
- `explicit_reference` preserves Telegram replies;
- `semantic_similarity` retains calibrated mutual top-four embedding neighbors, using separate within-work and cross-work thresholds.

Free-form tags remain visible browsing facets but no longer determine topology. Provenance edges are factual; semantic edges are model-derived candidates and store their model, score, and selection rule in human-readable evidence. Concept definitions are embedded separately to retrieve plausible alias/merge candidates for the maintenance task.

## Application boundary

Fastify exposes status, graph retrieval, file import, enrichment processing, and a legacy note-review endpoint. The React client consumes the graph API and presents Network and Sources views. Selecting a node opens an inspector containing canonical evidence, generated fields, provenance, and connected notes. Production builds place the client under `dist/web` and the server under `dist/server`.

CLI commands cover database initialization, file ingestion, Telegram discovery/sync, enrichment, status, and stable JSON export. This CLI/API boundary is also the foundation for a future agent-callable synchronization tool.

## Privacy, limitations, and evolution

The intended default processing path is local. `.env`, the SQLite database, model weights, and temporary media are Git-ignored. Telegram itself remains an external transport, and any future remote QA must be explicit rather than part of routine processing.

Current limitations are deliberate: English-only OCR/transcription, no reliable original screenshot timestamp, embedding thresholds still need a user-labeled evaluation set, merge proposals are stored but not automatically applied, and work-level summaries, source reassignment, and external QA are not yet implemented. SQLite remains appropriate until graph scale or traversal requirements justify a dedicated graph store.
