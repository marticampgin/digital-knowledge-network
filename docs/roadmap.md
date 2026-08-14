# Product assessment and roadmap

## Assessment

The idea is valuable because it targets the neglected part of personal knowledge management: turning low-friction capture into trustworthy, reusable units without asking the user to reorganize everything manually. The strongest differentiator is not the graph visualization; it is the auditable transformation from source evidence to a gradually improving personal model.

The main product risks are:

1. **False context:** an LLM can confidently invent what a screenshot meant outside its page. Mitigation: preserve nearby pages, book metadata, exact quotes, confidence, and a review queue; instruct the model to abstain.
2. **Graph noise:** automatic similarity produces a visually impressive hairball with little retrieval value. Mitigation: typed edges, thresholds, evidence, filters, and user confirmation for important semantic links.
3. **Premature atomization:** one screenshot is not always one idea, while several screenshots can be one idea. Mitigation: model captures, groups, and notes separately; make merge/split reversible.
4. **Capture friction:** Telegram is convenient but export/sync and privacy must be predictable. Mitigation: use a dedicated private bot/chat, incremental cursors, idempotent file hashes, and a local pull command.
5. **Unmeasured model quality:** swapping prompts or models without a fixed evaluation set will hide regressions. Mitigation: build a gold set of 50-100 personally representative captures and score faithfulness, atomicity, tags, and abstention.
6. **False chronology:** Telegram send time may be much later than the original capture time. Mitigation: store capture, receive, and import times separately, with provenance and confidence.

## Recommended delivery order

### Milestone 1 - trustworthy text pipeline (current foundation)

- Local database, source provenance, idempotent ingest.
- Text/Markdown segmentation and atomic enrichment.
- Typed source/tag edges and JSON export.
- Prompt/model version recording and synthetic tests.

Exit criterion: 100 text notes can be imported twice without duplicates, processed, traced to sources, and exported.

### Milestone 2 - screenshot-first workflow

- Ephemeral media downloads with canonical OCR/transcript storage and no persistent binary archive.
- Separate original capture time, Telegram receive time, and local import time, including timestamp provenance and confidence.
- Book/work entities and explicit capture-to-work assignment.
- OCR adapter with bounding boxes and confidence.
- Screenshot grouping using explicit replies/topics, Telegram album ID, trustworthy capture time, filename order, and page-number hints.
- Merge/split/reorder review controls and attachment to an older note.

Exit criterion: a 50-screenshot book batch yields correctly ordered, reviewable candidate notes without losing the images, chronology uncertainty, or OCR evidence.

### Milestone 3 - meaningful connections and exploration

- Local embedding model and nearest-neighbor candidate generation.
- LLM verification of candidate edges with a named relationship and evidence.
- Full-text/semantic search plus a graph UI that filters by source, tag, edge type, confidence, and date.
- Bounded book/source context packets, citations, and optional retrieval over locally supplied full text.
- Versioned, incremental summaries of the captured notes for each work, with coverage indicators.

Exit criterion: users can answer "where did this idea come from?", inspect a faithful summary of their captured material, and discover a useful cross-source connection without navigating a hairball.

### Milestone 4 - Telegram sync and agent tool

- Incremental Telegram adapter with dry-run, checkpointing, and retries.
- One orchestration command: sync -> extract -> review queue -> enrich -> link -> summarize -> export.
- Stable machine-readable command/API contract so an AI agent can invoke the workflow and inspect results.

Exit criterion: repeated syncs are safe and an agent can run the pipeline without accessing secrets or private note content beyond its granted scope.

### Milestone 5 - QA and improvement loop

- Local evaluation set and prompt comparison harness first.
- Optional remote reviewer that receives only explicitly selected content.
- Structured verdicts: faithful, missing context, over-expanded, bad tags, bad segmentation.
- Aggregate error analysis before fine-tuning.

Exit criterion: model/prompt changes have measurable quality deltas and remote review cannot leak the full local corpus.

## Important correction to the initial GitHub Actions idea

GitHub Actions is appropriate for tests and synthetic evaluation fixtures. It is a poor default executor for private-note QA because a hosted runner requires uploading content and secrets to GitHub infrastructure. Keep private processing on the machine. If remote third-party QA is later desired, make it an explicit local command with a preview of exactly what will leave the device; CI can still validate the code path with fake data.

## Near-term decisions

- Start with files, then Telegram; this isolates knowledge modeling from chat API complexity.
- Use SQLite before a graph database.
- Use LFM2.5-2.6B through a replaceable local HTTP adapter, not directly inside the app process.
- Use dedicated OCR and speech models; the selected LFM is text-only.
- Give the model a bounded source context packet on each run rather than relying on model memory.
- Label source summaries as summaries of captured notes unless the complete source is available.
- Postpone fine-tuning until a reviewed dataset reveals consistent prompt-level failures.

See [Capture time, source context, grouping, and summaries](capture-context-and-summaries.md) for the detailed data rules and implementation phases.
