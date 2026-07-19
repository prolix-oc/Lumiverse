---
title: Embeddings
---

# Embeddings

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
| **BananaBread** | Lumiverse's local embedding server. Defaults to `http://localhost:8008/v1/embeddings` and pulls its model list from `/v1/models`. |
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
| **Chat Documents** | `vectorize_chat_documents` | Indexes [databank](../chatting/databank.md) and chat-attached documents for `#slug` mentions and document RAG |
| **Chat Messages** | `vectorize_chat_messages` | Enables [long-term memory](../chatting/memory.md) — recalls relevant past messages during generation |

When chat-message vectorization is enabled, the **Memory Retrieval Mode** (`chat_memory_mode`) controls how aggressively past messages are recalled:

| Mode | Behavior |
|------|----------|
| **Conservative** | Fewer, high-quality memories — strict threshold |
| **Balanced** | Standard retrieval (recommended) |
| **Aggressive** | More memories, lower threshold — better for long epics |

---

## World Book Vector Presets

A quick preset row above the chunk parameters auto-tunes lorebook vectorization:

| Preset | Best For |
|--------|----------|
| **Lean** | Tight token budgets, short chunks |
| **Balanced** | General use (recommended) |
| **Deep** | Large lorebooks where each entry is dense |
| **Custom** | Manual control — editing any value switches the row to Custom |

The preset row drives the **Retrieved Entries**, **Chunk Target / Max / Overlap Tokens**, and **Stored Chunks Per Entry** values.

---

## Retrieval Settings

### Similarity Threshold

Maximum cosine distance for matches. Lower values = stricter matching.

- **0** — No filtering (accept all matches)
- **0.3-0.5** — Moderate filtering
- **0.8+** — Very strict (only highly similar content)

Cosine distance can exceed 1.0 in LanceDB's implementation, so this isn't capped at 1.

### Rerank Cutoff

For world book vectors: minimum score required after boost/penalty adjustments. Helps filter out low-quality matches after post-processing. Set to 0 to disable.

---

## Hybrid Weight

Controls the balance between traditional keyword matching and semantic vector search:

| Mode | Behavior |
|------|----------|
| **Keyword First** | Prioritize exact word matches; use vectors as a tiebreaker |
| **Balanced** | Weight both methods equally (recommended) |
| **Vector First** | Prioritize semantic similarity; keywords are secondary |

---

## Runtime

| Setting | Description |
|---------|-------------|
| **Batch Size** | Entries or chunks embedded per request during reindexing (1-200, default 50) |
| **Request Timeout** | Per-request timeout in seconds (0 disables, max 300). Useful for slow self-hosted models. |
| **Preferred Context Size** | Recent messages used to build the chat-memory search query (default 6, max 64) |

---

## Tips

!!! tip "Start with OpenAI's small model"
    `text-embedding-3-small` is cheap, fast, and effective. It's the best starting point for most users.

!!! tip "Enable world book vectorization first"
    Semantic world book search is the highest-impact use of embeddings. Long-term memory is valuable too, but world book vectorization gives immediate improvement with less configuration.

!!! tip "Test after setup"
    Always click Test API after configuration. This verifies your credentials work and auto-detects the correct dimensions — getting dimensions wrong produces garbage results.
