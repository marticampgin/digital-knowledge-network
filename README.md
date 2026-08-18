# Digital Knowledge Network

A local-first application that turns text, screenshots, and audio into provenance-preserving atomic notes and an interactive knowledge graph.

The project deliberately separates **capture**, **extraction**, **grouping**, **enrichment**, and **connection**. Canonical source text—submitted text, OCR, or transcription—is never overwritten by an LLM interpretation. Uploaded media is temporary and is deleted after extraction.

## What works now

- Ingest UTF-8 text/Markdown, common image formats, and English audio.
- Run offline OCR with locally packaged Tesseract English data.
- Transcribe Telegram voice notes and common audio with local Whisper `base.en`.
- Discover and incrementally synchronize a dedicated Telegram group.
- Register a book/article with `/source kind | title | optional author`, bind it to its Telegram topic, and inherit that source on later captures.
- Combine every ordered Telegram album into one atomic note while preserving the unchanged OCR text from each screenshot as its source evidence.
- Group more than ten related uploads with `/passage start`, `/passage end`, and reply-based `/passage continue`.
- Split one capture into atomic notes with `---` dividers or Markdown headings.
- Deduplicate imports by content hash.
- Enrich notes either with a deterministic offline baseline or any OpenAI-compatible local model server.
- Store sources, notes, provenance, model/prompt metadata, and typed graph edges in local SQLite.
- Generate versioned, note-cited summaries of all captured material from one work with hierarchical batching.
- Explore a responsive low-poly hierarchy: work-level knowledge cells, emergent themes, and semantically arranged atomic notes with inspectable canonical source text.
- Export a stable JSON graph for another client or agent tool.

The visible topology is semantic: local MiniLM neighbors arrange notes inside each work, while size-normalized theme matches connect works. Provenance is retained in SQLite and the inspector but does not distort layout. Graph caps and thresholds can be tuned in the interface without rerunning OCR or the LLM.

## Quick start

Requires Node.js 22.13 or newer.

```powershell
npm install
npm run models:setup
npm run build
node dist/server/cli.js init
node dist/server/cli.js ingest .\path\to\notes.md
node dist/server/cli.js process
node dist/server/cli.js status
node dist/server/cli.js export
```

Use a local OpenAI-compatible server:

```powershell
$env:DKN_LLM_BASE_URL='http://127.0.0.1:8080/v1'
$env:DKN_LLM_MODEL='LiquidAI/LFM2.5-2.6B'
$env:DKN_LLM_API_KEY='local'
node dist/server/cli.js process --provider openai
```

`npm run models:setup` downloads the 1.7 GB LFM2.5 `Q4_K_M` GGUF, 148 MB Whisper `base.en`, and a pinned Windows Vulkan runtime under the git-ignored `.dkn` directory. `npm run models:start` detects the GPU and offloads all language-model layers to it. Keep that command running in its own terminal.

Run the application in development:

```powershell
npm run app
```

Open `http://127.0.0.1:5173`. For a production build, run `npm run build`, then `npm start` and open `http://127.0.0.1:4174`.

For the normal Telegram workflow, one command starts any missing local services, synchronizes captures, enriches pending notes, rebuilds connections, and leaves the application available at `http://127.0.0.1:4174`:

```powershell
npm run sync
```

To open the existing application without synchronizing or processing anything, run `npm start`. To generate a summary of one finished work without Telegram synchronization, run:

```powershell
npm run summarize -- "The Everything Store"
```

This starts the local GPU model if necessary, summarizes only the captured atomic notes, stores a versioned revision, and writes Markdown under `.dkn/summaries/`. Repeating it reuses the current revision unless notes changed; add `-Refresh` to regenerate deliberately.

See [Telegram setup](docs/telegram-setup.md) for the exact BotFather, privacy, group discovery, and first-sync procedure.

## Atomic note format

One file is a source capture. A file containing `---` separators becomes multiple ordered atomic notes:

```markdown
# Feedback loops

Short feedback loops accelerate deliberate practice.

---

# Error signals

An error signal is useful only when it can change the next attempt.
```

If no divider exists, multiple Markdown headings are used as boundaries. Otherwise, the whole file is one note.

## Design documents

- [User manual](docs/user-manual.md)
- [Technical overview](docs/technical-overview.md)
- [Knowledge graph strategy](docs/graph-strategy.md)
- [Architecture](docs/architecture.md)
- [Product assessment and roadmap](docs/roadmap.md)
- [Capture time, source context, grouping, and summaries](docs/capture-context-and-summaries.md)
- [Telegram capture workflow](docs/telegram-user-workflow.md)
- [Telegram setup](docs/telegram-setup.md)
- [Interface concept](docs/design/network-concept.png)
