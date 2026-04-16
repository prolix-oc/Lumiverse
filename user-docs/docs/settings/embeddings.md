# Embeddings & Vector Search

Embeddings power two features in Lumiverse: **semantic world book activation** (finding lorebook entries by meaning, not just keywords) and **long-term chat memory** (recalling relevant past moments). Both require an embedding provider to be configured.

---

## What Are Embeddings?

An embedding is a numerical representation of text — a list of numbers that captures the *meaning* of a passage. Similar texts produce similar embeddings. This lets Lumiverse find relevant content based on what it *means*, not just whether exact keywords match.

**Without embeddings:** World book entries activate only on keyword matches. Chat history outside the context window is lost.

**With embeddings:** World book entries can activate on *semantically similar* concepts. Past conversation moments can be recalled based on relevance.

---

## Setting Up

Open **Settings > Embeddings** and follow the setup checklist:

### 1. Enable Embeddings

Toggle the master switch on.

### 2. Select a Provider

| Provider | Notes |
|----------|-------|
| **OpenAI** | Official OpenAI API (`text-embedding-3-small` recommended) |
| **OpenAI Compatible** | Any service implementing the OpenAI embeddings API (local models, self-hosted) |
| **OpenRouter** | Aggregation service |
| **ElectronHub** | Model aggregator |
| **Nano-GPT** | Pay-per-token aggregator |

### 3. Configure the Connection

| Field | Description |
|-------|-------------|
| **API URL** | Base URL for the provider. Auto-appends `/v1/embeddings` if no path is specified. |
| **Embedding Model** | Model name (e.g., `text-embedding-3-small`) |
| **API Key** | Your provider's authentication key |
| **Dimensions** | Vector size — auto-detected when you run a test |
| **Send Dimensions** | Whether to include the dimension value in API requests (some providers require it, others reject it) |

### 4. Test the API

Click **Test API** to verify your setup. A successful test auto-detects the model's native dimensions and applies them.

---

## What Gets Vectorized

Enable vectorization for the content types you want:

| Content | Setting | What It Does |
|---------|---------|-------------|
| **World Book Entries** | `vectorize_world_books` | Enables semantic search for lorebook entries — activates entries by meaning, not just keywords |
| **Chat Messages** | `vectorize_chat_messages` | Enables [long-term memory](../chatting/memory.md) — recalls relevant past messages during generation |
| **Chat Documents** | `vectorize_chat_documents` | Indexes documents attached to chats |

---

## Retrieval Settings

### Vector Recall Size (Top-K)

How many vector matches to retrieve per query. Higher values cast a wider net but use more tokens.

- **4** — Focused retrieval (default)
- **8-12** — Broad retrieval for complex stories

### Similarity Threshold

Maximum cosine distance for matches. Lower values = stricter matching.

- **0** — No filtering (accept all matches)
- **0.3-0.5** — Moderate filtering
- **0.8+** — Very strict (only highly similar content)

Cosine distance can exceed 1.0 in LanceDB's implementation, so this isn't capped at 1.

### Rerank Cutoff

For world book vectors: minimum score required after boost/penalty adjustments. Helps filter out low-quality matches after post-processing.

---

## Hybrid Weight

Controls the balance between traditional keyword matching and semantic vector search:

| Mode | Behavior |
|------|----------|
| **Keyword First** | Prioritize exact word matches; use vectors as a tiebreaker |
| **Balanced** | Weight both methods equally (recommended) |
| **Vector First** | Prioritize semantic similarity; keywords are secondary |

---

## Batch Processing

| Setting | Description |
|---------|-------------|
| **Batch Size** | Entries per API request during reindexing (1-200, default 50) |
| **Preferred Context Size** | Recent messages used to build the search query (default 6) |

---

## Tips

!!! tip "Start with OpenAI's small model"
    `text-embedding-3-small` is cheap, fast, and effective. It's the best starting point for most users.

!!! tip "Enable world book vectorization first"
    Semantic world book search is the highest-impact use of embeddings. Long-term memory is valuable too, but world book vectorization gives immediate improvement with less configuration.

!!! tip "Test after setup"
    Always click Test API after configuration. This verifies your credentials work and auto-detects the correct dimensions — getting dimensions wrong produces garbage results.
