# Knowledge graph strategy

## Assessment of the current graph

The original MVP used source/capture sequence plus Jaccard overlap of LLM-generated tags. The current implementation replaces that topology with the first provenance-first hybrid layer described below: work/source/reply structure, a controlled concept registry, and mutual-nearest-neighbor embeddings.

This is explainable and inexpensive, but it has structural weaknesses:

- free-form tags fragment synonyms, spelling variants, and different levels of abstraction;
- generic tags such as a person or book title dominate more meaningful relations;
- a degree cap can prevent valid bridges after popular nodes fill their quota;
- separate captures from the same work do not currently create a work-level backbone;
- tag overlap represents vocabulary agreement, not semantic equivalence, causality, support, or contradiction;
- changing the prompt or model can reorganize the graph even when source evidence is unchanged.

The graph should therefore treat tags as human-facing facets, not as its primary topology.

## Recommended multi-view model

Use one durable evidence layer and several derived, independently rebuildable views.

### 1. Provenance backbone

Always retain deterministic relationships: note-to-capture, capture-to-work, album/passage membership, explicit replies, and ordered adjacency within a work/topic. These edges are facts about origin, not semantic guesses, and must remain visible even when every model-derived index is rebuilt.

### 2. Controlled concept layer

Replace isolated tag strings with concept records. Each concept has a stable ID, one preferred label, aliases, a short definition, provenance, and optional broader/narrower/related concepts. Every atomic note receives exactly one primary concept. Retrieval presents at most one semantically credible existing candidate to the selector; it either accepts that candidate or proposes exactly one new concept. New proposals are canonicalized by lexical normalization before creation, while a separate maintenance task can suggest aliases and merges without applying them automatically.

This follows the SKOS distinction between concepts and their preferred, alternative, and hidden labels rather than treating every label spelling as a new concept. See the [W3C SKOS reference](https://www.w3.org/TR/skos-reference/).

### 3. Semantic note layer

Embed a stable note representation containing the core idea plus limited context and source metadata. Use cosine similarity to generate candidates, but retain only calibrated mutual-nearest-neighbor edges: A should be among B's best matches as well as B among A's. Require a minimum score learned from a small labeled set, keep separate thresholds for within-work and cross-work links, and store model/version/score on every edge.

Dense embeddings recover synonyms and paraphrases that tags miss. Sentence Transformers documents cosine-based semantic search and evaluation for corpora far larger than this application, but model choice and thresholds still require task-specific evaluation: [semantic search](https://www.sbert.net/examples/sentence_transformer/applications/semantic-search/README.html) and [evaluation](https://www.sbert.net/docs/package_reference/sentence_transformer/evaluation.html).

### 4. Typed entity and claim layer

Extract canonical entities, claims, and explicit relationships with evidence spans. Examples include `Amazon --adopted--> service-oriented architecture`, `claim A --supports--> claim B`, or `claim A --contradicts--> claim B`. Entity linking and relation canonicalization should happen after extraction, not be delegated to unconstrained tag generation.

Microsoft GraphRAG similarly separates text units, entities, relationships, communities, reports, and embeddings instead of using a single tag graph. Its standard pipeline extracts entities and relationships, detects communities, creates hierarchical reports, and embeds multiple artifacts: [overview](https://microsoft.github.io/graphrag/index/overview/) and [dataflow](https://microsoft.github.io/graphrag/index/default_dataflow/).

### 5. Community and summary layer

Run community detection over the stable semantic/entity graph, then maintain summaries at several levels: passage, topic cluster, work, and cross-work theme. Communities are derived navigation aids, never source-of-truth classifications. Microsoft GraphRAG uses hierarchical Leiden communities and community reports for local-to-global exploration; its original method is described in [From Local to Global](https://arxiv.org/abs/2404.16130).

## Edge policy for the visual network

The visible graph should combine signals without collapsing their meanings:

- solid edges: explicit/provenance relationships;
- soft edges: calibrated semantic similarity;
- directional edges: typed claims or references;
- node color or hull: derived community;
- concept chips: controlled facets, not automatic edges by themselves.

Do not use a single global degree cap. Apply per-edge-type limits, preserve all explicit edges, use mutual top-k for semantic edges, and ensure every component's separation is explainable. Generic concepts should contribute less than specific ones, analogous to inverse document frequency.

## Evaluation before scaling

Create a representative gold set of related and unrelated note pairs, including relation types and difficult near-misses. Compare graph versions using:

- precision@k and recall@k for useful neighbors;
- nDCG or MRR for ranked retrieval;
- isolated-node and disconnected-component rates;
- edge stability across prompt/model versions;
- generic-concept dominance and degree distribution;
- human judgments of explanation quality and unexpected discovery.

The implemented foundation is intentionally not a full GraphRAG clone: it now has work-sequence edges, explicit replies, a controlled concept registry, local MiniLM embeddings, and a separate semantic edge type. The next quality milestone is a small labeled neighbor set that calibrates within-work and cross-work thresholds. Entities, claims, communities, and summaries should follow only after that evaluation.
