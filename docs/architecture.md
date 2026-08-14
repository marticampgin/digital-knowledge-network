# Architecture

## Product boundary

The durable product is a **local knowledge ledger plus derived graph**, not a chat transcript and not a folder of generated summaries. Every interpretation must remain traceable to the exact captured material and the process that produced it.

```text
Telegram / files / screenshots / audio
                 |
                 v
      canonical source evidence
                 |
        extractor by media type
                 |
                 v
          atomic raw notes
                 |
      local structured enrichment
                 |
                 v
       reviewed knowledge notes
                 |
     typed, evidenced graph edges
                 |
        search / graph UI / agent tool
```

## Layers

1. **Capture adapters** fetch inputs temporarily and preserve message ID, chat ID, timestamps, captions, and album/group IDs.
2. **Extraction adapters** convert media to text. OCR and speech-to-text outputs become canonical source evidence and retain confidence/page/time spans; temporary media files are then deleted.
3. **Segmentation** groups adjacent screenshots or text blocks into candidate atomic notes. It must be reversible because page proximity is a hint, not truth.
4. **Enrichment** produces a self-contained core idea, limited supporting context, controlled tags, and a confidence score. The model output never replaces raw text.
5. **Review** records accept/edit/reject decisions. Low-confidence extraction or enrichment enters a queue.
6. **Graph derivation** creates typed edges. Source order, shared tags, semantic similarity, and explicit references are different relationships and must not be collapsed into a generic “related” edge.
7. **Consumers** include a graph explorer, search/RAG, exports, and a future agent-callable synchronization tool.

## Storage decision

SQLite is the source of truth for v0.x: it is local, transactional, portable, easy to back up, and sufficient for thousands to low millions of notes. It stores submitted text, OCR, transcripts, provenance metadata, and derived notes. Uploaded media is only an extraction input and is not retained. A dedicated graph database would add operational weight before graph traversal requirements justify it.

The initial schema keeps:

- `sources`: immutable captured content and provenance;
- `notes`: extracted text plus separately stored enrichment and processing state;
- `edges`: typed, weighted, evidenced relationships.

Later migrations add extraction spans, revisions, model runs, review decisions, embeddings, collections/authors/books, and sync cursors. These are additions, not reasons to discard the core model.

## Model boundary

The application talks to an OpenAI-compatible HTTP interface. This permits `llama.cpp`, LM Studio, SGLang, or another runtime without contaminating domain logic. Prompts are versioned and model identity is stored per note so results can be reproduced and compared.

LFM2.5-2.6B is a sensible candidate for constrained JSON extraction and agentic orchestration. It is text-only, so it does not replace OCR or transcription. Its own model card discourages knowledge-heavy use; enrichment prompts must therefore be grounded exclusively in supplied source text. Use low temperature and schema validation.

## Privacy and trust invariants

- No network egress in the default pipeline.
- Raw captures are immutable and content-hashed.
- Generated text is visibly distinct from quotations.
- Every derived note records its model and prompt version.
- Every graph edge has a type, weight, and human-readable evidence.
- Remote QA is opt-in per source, redacted where possible, and never runs merely because code was pushed.
- GitHub Actions must not receive the private note database. CI should test code using synthetic fixtures; a separate user-triggered client job may call remote QA.
