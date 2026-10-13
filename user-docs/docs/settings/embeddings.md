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

First open the **Connections** drawer. Under **Embedding Models**, create a connection for each embedding endpoint you want to use. Then open **Settings > Embeddings** and follow the setup checklist:

### 1. Enable Embeddings

Toggle the master switch on.

### 2. Select a Connection

Choose one of your saved **embedding connections** as the primary connection. Chat/LLM connections are intentionally not offered here, even when they use an OpenAI-compatible endpoint.

Existing embedding setups are migrated automatically. If you selected an OpenAI-compatible chat connection during the previous shared-profile workflow, Lumiverse preserves its embedding endpoint and copies its key into the dedicated embedding connection without removing the key from the chat connection.

The available providers include Lumiverse's built-ins and any embedding providers contributed by enabled [Spindle extensions](../extensions/index.md#extension-provided-ai-providers).

### 3. Choose a Provider and Model

| Provider | Notes |
|----------|-------|
| **OpenAI** | Official OpenAI API (`text-embedding-3-small` recommended) |
| **OpenAI Compatible** | Any service implementing the OpenAI embeddings API (local models, self-hosted) |
| **Mistral** | Native Mistral embeddings API. Defaults to `mistral-embed`; model browsing uses Mistral's model catalogue. |
| **Cohere** | Native Cohere v2 Embed API. Defaults to `embed-v4.0`; Lumiverse automatically sends document/query input types. |
| **OpenRouter** | Aggregation service |
| **ElectronHub** | Model aggregator |
| **BananaBread** | Lumiverse's local embedding server. Defaults to `http://localhost:8008/v1/embeddings` and pulls its model list from `/v1/models`. |
| **Nano-GPT** | Pay-per-token aggregator |
| **Spindle extension** | An enabled extension may contribute an embedding provider. Availability and model options depend on that extension. |

### 4. Configure the Connection

| Field | Description |
|-------|-------------|
| **Connection** | Dedicated embedding connection selected from **Connections > Embedding Models**. |
| **API URL** | Base URL for the provider. Auto-appends `/v1/embeddings` if no path is specified. |
| **Embedding Model** | Model name (e.g., `text-embedding-3-small`) |
| **API Key** | Your provider's authentication key |
| **Dimensions** | Vector size — auto-detected when you run a test |
| **Send Dimensions** | Whether to include the dimension value in API requests (some providers require it, others reject it) |

For Mistral and Cohere, Lumiverse translates **Send Dimensions** to each native API's `output_dimension` field. Cohere requests are also split automatically when a batch exceeds its 96-text API limit.

### 5. Add Fallback Connections (Optional)

Under **Primary and fallback connections**, add backup embedding connections in the order Lumiverse should try them. If the primary request fails or times out, Lumiverse advances through this chain without sharing one profile's API key with another profile.

Every endpoint in a fallback chain must produce vectors with the same dimensions as the primary endpoint. Set a fallback's **Dimensions** when Lumiverse cannot determine it automatically. A known dimension mismatch is skipped instead of mixing incompatible vectors in the same index.

!!! warning "Changing dimensions requires reindexing"
    Existing vectors cannot be compared with vectors of another size. If you intentionally move to a provider or model with different dimensions, rebuild the affected embeddings after saving the new configuration.

### 6. Test the API

Click **Test API** to verify your setup. A successful test auto-detects the model's native dimensions and applies them.

Test the primary and every fallback before relying on the chain. The displayed **Fallback chain** shows the order Lumiverse will use.

---

## What Gets Vectorized

Enable vectorization for the content types you want:

| Content | Setting | What It Does |
|---------|---------|-------------|
| **World Book Entries** | `vectorize_world_books` | Enables semantic search for lorebook entries — activates entries by meaning, not just keywords |
| **Chat Documents** | `vectorize_chat_documents` | Indexes [databank](../chatting/databank.md) and chat-attached documents for `#slug` mentions and document RAG |
| **Chat Messages** | `vectorize_chat_messages` | Enables [long-term memory](../chatting/memory.md) — recalls relevant past messages during generation |

Configure chat recall under **Settings → Advanced → Long-Term Chat Memory**. Its **Memory Mode** presets (Conservative, Balanced, Aggressive, Manual) set chunk sizes, overlap, and the recent-message exclusion window. They do not change the similarity threshold or Top-K. Explicit settings there take precedence over the legacy embedding-level chat-memory mode.

Basic Chat Memory works with **Memory Cortex disabled**. Cortex's Simple/Standard/Advanced modes are separate analysis settings under **Settings → Memory Cortex**. [Summary](../chatting/loom-summary.md) uses an LLM connection and does not require embeddings.

Enable **Vectorise chat messages**, then use **Recompile Memories** in the chat input bar's quick menu to prepare existing history. Add `{{memories}}` to an enabled preset block: basic recall defaults to **Macro only**, not automatic injection. See [Long-Term Memory](../chatting/memory.md) for setup, stored versus vectorized chunks, and injection rules.

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
- **Smaller positive values** — Stricter filtering
- **Larger positive values** — Permit more distant matches

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

!!! tip "Use genuinely independent fallbacks"
    A second profile pointing to the same upstream may fail during the same outage. For resilience, choose another provider or independently hosted endpoint with a dimension-compatible model.
