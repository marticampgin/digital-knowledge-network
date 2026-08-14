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

## Capture notes

- **Text:** send a normal Telegram message in the relevant topic.
- **Screenshot:** send a clear English image. OCR output becomes the canonical source text; the image is deleted after extraction.
- **Audio:** send an English voice message or audio file under 20 MB. The local Whisper model produces the canonical transcript.
- **Related pages:** send up to ten screenshots as one Telegram album. The ordered album becomes one atomic note.
- **Long passage:** send `/passage start`, upload any number of albums/messages, then send `/passage end`. Everything inside becomes one ordered atomic note.
- **Continue an older passage:** reply to one of its imported Telegram messages with `/passage continue`, add material, then send `/passage end`.

Separate messages are separate notes unless they are grouped by an album or passage command. Telegram records upload time, not reliably when an offline screenshot was originally taken, so do not treat the graph as a guaranteed capture-time chronology.

## Synchronize and process

Run these from the project directory whenever new material has been sent:

```powershell
npm run dev -- telegram sync
npm run models:start
npm run dev -- process --provider openai
npm run dev -- status
```

Run `models:start` in its own terminal and leave it open while processing. Synchronization is incremental and content-hash deduplicated. Re-running it is safe. The default local model is `LiquidAI/LFM2.5-2.6B`; its endpoint and model name can be changed in `.env`.

## Use the application

Start the production application with `npm start` and open `http://127.0.0.1:4174`. For development, use `npm run app` and open `http://127.0.0.1:5173`.

- **Network:** pan, zoom, fit, search, and filter the knowledge graph. Select a node to inspect its idea, tags, context, source, and connections.
- **Sources:** browse notes as a list. Selecting one stays in Sources and opens its evidence panel.
- **Canonical source text:** this is the stored original text, OCR result, or transcript. It is not rewritten by the LLM. Use **Copy source text** to copy it.
- **LLM-generated fields:** Core Idea, Context, and Tags are interpretations and are visibly labeled. They never replace the canonical evidence.
- **Import:** the top-bar Import action accepts text/Markdown, common image formats, and common English audio formats. Direct UI imports currently receive deterministic heuristic enrichment. To use local-LLM enrichment for a file, ingest it with `npm run dev -- ingest <path>`, then run the OpenAI-compatible processing command.

Graph connections currently represent ordered notes from the same source/capture or shared LLM-generated tags. A connection is navigational evidence, not proof that two ideas are semantically equivalent.

## Local data and recovery

The database, downloaded models, OCR cache, and temporary processing files live under `.dkn/` by default and are excluded from Git. Back up `.dkn/knowledge.sqlite` while the app is stopped to preserve the knowledge base. Never commit `.env` or `.dkn/`.

If Telegram imports nothing, send a fresh message: Bot API updates expire after roughly 24 hours and the bot cannot read history from before it joined. If OCR or transcription fails, keep the original media outside the application and retry after improving the crop/audio or checking `npm run models:setup` and FFmpeg availability.

Work summaries, manual source reassignment, semantic embeddings, and optional external QA are planned but not implemented yet.
