# Long-Term Memory

Long-term memory gives the AI the ability to recall relevant moments from earlier in the conversation — even if those moments have long since scrolled out of the context window. It works by chunking your chat history into vectors and retrieving the most relevant pieces on each generation.

---

## How It Works

1. Your chat history is split into **chunks** (groups of messages)
2. Each chunk is converted to a vector embedding (a numerical representation of its meaning)
3. When you generate a new message, recent context is used as a search query
4. The most semantically similar chunks are retrieved and injected into the prompt
5. The AI "remembers" relevant past events, even from hundreds of messages ago

!!! note "Requires Embeddings"
    Long-term memory requires the [Embeddings](../settings/embeddings.md) system to be configured. Without an embedding provider, memory cannot vectorize or search your chat history.

---

## Quick Presets

Choose a preset to auto-configure all memory parameters:

| Preset | Target Tokens | Max Tokens | Overlap | Exclusion Window | Best For |
|--------|:---:|:---:|:---:|:---:|------------|
| **Conservative** | 600 | 1,200 | 100 | 30 messages | Tight token budgets, focused recall |
| **Balanced** | 800 | 1,600 | 120 | 20 messages | General use (recommended) |
| **Aggressive** | 1,000 | 2,000 | 200 | 15 messages | Long stories where history matters |
| **Manual** | Custom | Custom | Custom | Custom | Full control over every parameter |

---

## Chunking Parameters

These control how your chat history is divided into pieces:

| Parameter | Description |
|-----------|-------------|
| **Target Tokens** | The ideal size for each chunk. The system aims for this length. |
| **Max Tokens** | Hard ceiling — no chunk exceeds this size. |
| **Overlap Tokens** | How many tokens of context are shared between adjacent chunks. Prevents information from being lost at chunk boundaries. |
| **Max Messages / Chunk** | Cap on messages per chunk (0 = unlimited). |
| **Time Gap Split** | Split chunks when there's a gap of N+ minutes between messages (0 = disabled). |
| **Split on Scene Breaks** | Automatically split at `---`, `***`, `===` markers. |

**Example:** With target 800 and overlap 120, a long conversation might produce chunks of ~800 tokens each, where the last ~120 tokens of Chunk 1 also appear at the start of Chunk 2. This overlap ensures the AI can follow context across chunk boundaries.

---

## Retrieval Parameters

These control what gets pulled from memory on each generation:

| Parameter | Description |
|-----------|-------------|
| **Top-K Results** | How many chunks to retrieve (e.g., 4-8). More = broader recall, more tokens used. |
| **Exclusion Window** | Don't retrieve chunks from the last N messages. These messages are already in the direct context — no need to duplicate them. |
| **Similarity Threshold** | Minimum relevance score. Chunks below this threshold are excluded even if they're in the top-K. Set to 0 to disable filtering. |

---

## Query Strategy

Controls how the search query is built:

| Strategy | Description |
|----------|-------------|
| **Recent Messages** | Uses the last N messages as the query — casts a broad net |
| **Last User Message** | Uses only your most recent message — very focused recall |
| **Weighted Recent** | Gives more weight to the most recent messages in the query |

**Query Context Size** determines how many messages feed into the query (for strategies that use multiple messages).

**Query Max Tokens** caps the total token budget for retrieved memories in the assembled prompt.

---

## Memory Macros

Retrieved memories are available in your preset through macros:

| Macro | Returns |
|-------|---------|
| `{{memories}}` | Formatted memory chunks with header template |
| `{{memoriesRaw}}` | Raw chunks without formatting |
| `{{memoriesActive}}` | `"yes"` or `"no"` — for conditional blocks |
| `{{memoriesCount}}` | Number of chunks retrieved |

Include `{{memories}}` in a preset block to inject retrieved context into the prompt.

---

## Formatting Templates

Customize how memories appear in the prompt:

- **Header Template** — Wraps the entire memory section (e.g., `"Relevant past events:\n{{memories}}"`)
- **Chunk Template** — Formats each individual chunk
- **Chunk Separator** — Divider between chunks

---

## Tips

!!! tip "Start with Balanced"
    The Balanced preset works well for most conversations. Switch to Aggressive for epic-length stories, or Conservative if you're running tight on tokens.

!!! tip "Set a reasonable exclusion window"
    The exclusion window prevents the system from "remembering" things that are already visible in the current context. A window of 20 means the last 20 messages won't appear as memories (they're already there as chat history).

!!! tip "Pair with Loom Summary"
    Memory and [Loom Summary](loom-summary.md) complement each other. Memory retrieves specific relevant moments; the summary provides a structured overview of the whole story. Use both for the best long-term coherence.
