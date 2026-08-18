# User manual

Digital Knowledge Network turns English text, screenshots, and audio into searchable atomic notes connected to their source. Processing and storage are local. Images and audio are temporary extraction inputs; the durable evidence is the submitted text, OCR text, or transcript.

## One-time setup

1. Install Node.js 22.13 or newer, then run:

   ```powershell
   npm install
   npm run models:setup
   npm run build
   ```

2. Create `.env` from `.env.example`. Keep this file private. Set the Telegram bot token and, after discovery, the group ID.
3. Add the bot to a private Telegram supergroup with Topics enabled. Make it an administrator or disable BotFather privacy mode and re-add it.
4. Send a new message in the group, then discover its ID:

   ```powershell
   npm run dev -- telegram discover
   ```

5. Put the returned ID in `.env` as `TELEGRAM_CHAT_ID`. Full BotFather and permission instructions are in [Telegram setup](telegram-setup.md).

## Organize sources in Telegram

Create one topic per durable source, such as a book or article. Inside that topic, register the source once:

```text
/source book | Exact Book Title | Author | Optional Edition | Optional ISBN
```

Valid kinds are `book`, `article`, `website`, `audio`, `video`, and `other`. The topic then supplies that source identity to future uploads. The application does not guess a source from OCR or model knowledge. Material outside a registered topic can remain unassigned.

Prefer to send `/source` before the first note in a new topic. The topic name is for you; it does not register the book by itself. When the command is synchronized, it binds both future captures and any existing imported captures from that same topic to the work, so material sent just before the command does not need to be re-uploaded. You do not need to repeat `/source` or use a global “current book” command.

## Capture notes

- **Text:** send a normal Telegram message in the relevant topic.
- **Screenshot:** send a clear English image. OCR output becomes the canonical source text; the image is deleted after extraction.
- **Audio:** send an English voice message or audio file under 20 MB. The local Whisper model produces the canonical transcript.
- **Related pages:** send up to ten screenshots as one Telegram album. The ordered album becomes one atomic note.
- **Long passage:** send `/passage start`, upload any number of albums/messages, then send `/passage end`. Everything inside becomes one ordered atomic note.
- **Continue an older passage:** reply to one of its imported Telegram messages with `/passage continue`, add material, then send `/passage end`.

Separate messages are separate notes unless they are grouped by an album or passage command. Telegram records upload time, not reliably when an offline screenshot was originally taken, so do not treat the graph as a guaranteed capture-time chronology.

## Synchronize and process

Run this from the project directory whenever new material has been sent:

```powershell
npm run sync
```

The command starts the GPU model server and production application when needed, synchronizes Telegram, enriches every pending note, rebuilds graph connections, prints final counts, and leaves the app available at `http://127.0.0.1:4174`. Synchronization is incremental and content-hash deduplicated, so rerunning it is safe.

The bundled Windows runtime uses Vulkan and offloads all language-model layers to `Vulkan0` by default. To choose another listed adapter for one session, set `$env:DKN_LLM_DEVICE='Vulkan1'` before running the workflow. The default model is `LiquidAI/LFM2.5-2.6B`; its endpoint and model name can be changed in `.env`.

Both long-running commands report live terminal progress. Telegram sync prints each message's position, extraction state, elapsed-time heartbeat, and result. LLM processing prints the queued total, current note, a heartbeat every five seconds, completion time, failures, and the final graph-edge count. `npm run models:start` is safe to repeat: if the server already owns port 8080, it reports the existing PID and exits without loading a duplicate model.

## Use the application

Start the production application with `npm start` and open `http://127.0.0.1:4174`. For development, use `npm run app` and open `http://127.0.0.1:5173`.

`npm start` only reads the existing local database and serves the current graph. It does not contact Telegram, start the language model, or reprocess notes. If no production build exists after a fresh clone, run `npm run build` once first.

- **Network:** begin in the knowledge landscape, where each polygon is a book, article, or other work. Select a work to read its evolving summary and emergent themes, then choose **Explore atomic notes**. Inside a work, cyan nodes are atomic notes, violet cells are derived themes, and dashed edges represent semantic similarity. Search narrows the current work without changing stored data.
- **Graph settings:** use the sliders icon to tune maximum connections, similarity floors, theme count and size limits, maximum theme share, and cross-work evidence/neighbor caps. **Apply & regenerate** rebuilds deterministic derived structure from stored embeddings; it never reruns capture, OCR, transcription, enrichment, or summarization. Use **Defaults** to restore the recommended balanced profile.
- **Sources:** browse notes as a list. Selecting one stays in Sources and opens its evidence panel.
- **Canonical source text:** this is the stored original text, OCR result, or transcript. It is not rewritten by the LLM. Use **Copy source text** to copy it.
- **LLM-generated fields:** Core Idea, Context, and descriptive Tags are interpretations and are visibly labeled. They never replace canonical evidence. Concepts are selected by a separate task from a controlled registry.
- **Import:** the top-bar Import action accepts text/Markdown, common image formats, and common English audio formats. Direct UI imports currently receive deterministic heuristic enrichment. To use local-LLM enrichment for a file, ingest it with `npm run dev -- ingest <path>`, then run the OpenAI-compatible processing command.

Graph connections distinguish what is stored from what is inferred. Same-source, passage order, Telegram replies, and work membership remain durable provenance records, but they do not pull atomic notes together visually. Inside a work, placement follows capped semantic nearest neighbors plus derived theme membership. Between works, links use a capped set of the strongest distinct theme pairs so a large book cannot win merely by having more notes. Similarity is evidence for navigation, not proof that two claims are equivalent. Tags never create edges.

## Summarize a finished work

Run one command with the exact registered title:

```powershell
npm run summarize -- "The Everything Store"
```

The command starts the GPU model server if needed but does not synchronize Telegram. It orders all enriched notes assigned to that work, summarizes them in bounded batches, recursively combines batches when required, and writes the final Markdown file to `.dkn/summaries/`. The overview is explicitly a summary of your captured notes—not a claim to summarize unseen parts of the book. Note references such as `[N003]` map back to exact note IDs at the bottom of the file.

The summary is cached by an input hash. Repeating the command is immediate when the notes are unchanged; adding or editing notes creates a new revision automatically. Use `npm run summarize -- "The Everything Store" -Refresh` only when you intentionally want another model-generated revision from identical inputs.

## Local data and recovery

The database, downloaded models, OCR cache, and temporary processing files live under `.dkn/` by default and are excluded from Git. Back up `.dkn/knowledge.sqlite` while the app is stopped to preserve the knowledge base. Never commit `.env` or `.dkn/`.

If Telegram imports nothing, send a fresh message: Bot API updates expire after roughly 24 hours and the bot cannot read history from before it joined. If OCR or transcription fails, keep the original media outside the application and retry after improving the crop/audio or checking `npm run models:setup` and FFmpeg availability.

Work summaries, manual source reassignment, applying concept-merge proposals, threshold evaluation on a labeled personal dataset, and optional external QA remain planned.
