---
title: Long-Term Memory
---

# Long-Term Memory

**Chat Memory**, **Long-Term Chat Memory**, and **LTM** refer to the same chat-history recall system. It stores earlier passages as chunks and retrieves context for later replies. **Memory Cortex is optional**: basic Chat Memory works with Cortex disabled.

## Which Memory System Am I Using?

| System | What it supplies | Where to configure it | Prompt macro |
|--------|------------------|-----------------------|--------------|
| **Summary / Loom Summary** | One saved, editable story overview, updated manually or by an LLM | Sidebar **Summary** panel | `{{loomSummary}}` |
| **Chat Memory** | Retrieved passages from earlier messages | **Settings → Advanced → Long-Term Chat Memory**; enable vectorization in **Settings → Embeddings** | `{{memories}}` |
| **Memory Cortex** | Recall ranked using narrative signals, plus entity facts, relationships, and scene/arc consolidations | **Settings → Memory Cortex**; inspect this chat in sidebar **Memory** | `{{memories}}` for combined context, or individual Cortex macros |

[Summary](loom-summary.md) is independent and does not require embeddings. Cortex adds analysis to chat chunks; it does not replace the Summary panel's saved summary. See [Memory Cortex](memory-cortex.md) for its setup.

### Stored Chunks Versus Vectorized Chunks

A **memory chunk** is stored text from your conversation. A **vectorized chunk** also has an embedding, which lets Lumiverse search by meaning. Sidebar **Memory → Stats → Memory chunks** shows the total and how many are vectorized. These are stages of the same system, not separate memory features.

Basic recall normally searches the vector index. While chunks await vectorization, or when an embedding/search request fails, the background refresh can fall back to recent eligible stored chunks. This **recency fallback** does not mean those passages were semantically relevant. Basic recall still requires **Enable embeddings** and **Vectorise chat messages**; switching vectorization off is not a separate non-vector memory mode.

## Set Up Chat Memory Without Cortex

1. Create an embedding connection in **Connections → Embedding Models**. In **Settings → Embeddings**, enable embeddings, select that connection and model, and run **Test API**. See [Embeddings](../settings/embeddings.md).
2. In the Embeddings tab, enable **Vectorise chat messages**.
3. Open **Settings → Advanced → Long-Term Chat Memory**. Choose **Memory Mode → Balanced**. Conservative, Balanced, Aggressive, and Manual live here; these are separate from Cortex's Simple, Standard, and Advanced modes.
4. Leave **Injection Strategy** at **Macro only**, and add `{{memories}}` to an enabled system prompt block in your active preset, usually before Chat History.
5. Open your chat and use **Recompile Memories** in the chat input bar's quick menu to prepare existing history. This works with Cortex disabled. Wait for processing before checking the prompt.

**Warm Long-Term Chat Memory when opening a chat** in the Advanced tab enables automatic preparation on chat open. Warmup is opt-in; manual recompilation works while it is off.

Retrieval reads a background-maintained cache. A cold cache can return no memories while a refresh is scheduled, so the first prompt after opening or changing a chat may have no recall. Short chats may also have no eligible old passages because of the exclusion window.

## Memory Mode and Chunking

All settings below are in **Settings → Advanced → Long-Term Chat Memory** and save automatically.

| Memory Mode | Target Tokens | Max Tokens | Overlap Tokens | Exclusion Window |
|-------------|:-------------:|:----------:|:--------------:|:----------------:|
| **Conservative** | 600 | 1,200 | 100 | 30 messages |
| **Balanced** | 800 | 1,600 | 120 | 20 messages |
| **Aggressive** | 1,000 | 2,000 | 200 | 15 messages |
| **Manual** | Custom | Custom | Custom | Custom |

Quick modes set these four values. They do **not** set a similarity threshold or change Top-K. Choose **Manual** to edit chunk sizes and the exclusion window yourself.

| Chunking setting | Meaning |
|------------------|---------|
| **Target Tokens / Max Tokens** | Desired chunk size and maximum size used when splitting text |
| **Overlap Tokens** | Text shared across neighboring chunks to preserve boundary context |
| **Max Messages / Chunk** | Message cap per chunk; 0 removes the cap |
| **Time Gap Split (min)** | Split after an idle gap; 0 disables this rule |
| **Split on scene breaks** | Split at recognized scene markers such as `---`, `***`, and `===` |

Use **Recompile Memories** after changing chunking or the embedding model to prepare the current chat's history again. Retrieval and formatting changes do not require rechunking.

## Retrieval and Query

| Setting | Meaning |
|---------|---------|
| **Top-K Results** | Maximum number of retrieved passages; default 4 |
| **Exclusion Window** | Exclude chunks touching the last N visible, nonempty messages; default 20. Avoids repeating recent history, but does not automatically match your actual context limit. |
| **Maximum vector distance** | Maximum cosine distance allowed. **Lower positive values are stricter**; 0 disables filtering. For example, 0.35 passes a 0.6 cutoff; 0.7 does not. Keyword-only and recency fallback hits have no measured vector distance and are excluded when filtering is active. |
| **Query Context Size** | Recent messages used to form the search query; default 6 |
| **Query Max Tokens** | Caps text used as the **search query**, not the retrieved memory section's token budget |

**Query Strategy** controls how search text is built:

- **Recent Messages** uses the last Query Context Size messages.
- **Last User Message** uses the most recent user message.
- **Weighted Recent** uses recent messages and repeats the newest one to emphasize it.

Cortex uses shared chunk/query settings and adds its own ranking and **Context Token Budget**. See [Cortex controls](memory-cortex.md#formatting-and-retrieval-controls).

The distance cutoff applies before Cortex ranking, including vault/interlink recall. Salience, recency, and other ranking signals cannot promote a passage beyond the distance cutoff. Cached results are checked again against the current cutoff during prompt assembly. Automatic scene/arc history replacement uses complete source spans rather than semantic retrieval, so it is independent of this cutoff.

## Put Memories in the Prompt

The simplest enabled system block is:

```text
{{memories}}
```

It is empty when no recall is available. An optional conditional wrapper is:

```text
{{if {{memoriesActive}} = yes}}
{{memories}}
{{/if}}
```

| Macro | Returns |
|-------|---------|
| `{{memories}}` | Formatted recall. A usable Cortex result can include graph and arc context too. Aliases: `{{chatMemory}}`, `{{longTermMemory}}`, `{{ltm}}`. |
| `{{memoriesRaw}}` | Chunks using Chunk Template and Chunk Separator, **without Header Template**. Not unformatted source text or the full Cortex section. |
| `{{memoriesActive}}` | `yes` when recall is enabled and has chunks or formatted context; otherwise `no` |
| `{{memoriesCount}}` | Retrieved chunk count; Cortex can supply graph context even when this is 0 |

`{{memories::2}}` and `{{memoriesRaw::2}}` limit the chunk list to two when more are available; they do not request another search. A reduced `{{memories::2}}` is reformatted from chunks. Use plain `{{memories}}` for the complete Cortex section.

### Injection Strategy

| Strategy | Behavior |
|----------|----------|
| **Macro only** (default) | Basic Chat Memory appears only where a memory content macro is used. |
| **Automatic fallback** | Without a memory content macro in applicable enabled blocks, insert the section as a system message before Chat History. |
| **Disabled** | Suppress the combined memory section and `{{memories}}` output. |

**Cortex exception:** usable Cortex or linked memory context can still receive automatic fallback under **Macro only**. A content macro such as `{{memories}}`, `{{entities}}`, `{{relationships}}`, `{{arc}}`, or `{{characterColors}}` owns placement and prevents that combined fallback. Status/count macros alone do not own placement. See [Cortex prompt placement](memory-cortex.md#put-cortex-in-the-prompt).

Disabled does not disable standalone Cortex macros. To stop all Cortex output, turn Cortex off globally or for this chat as well. To stop basic recall, turn **Vectorise chat messages** off. Removing a macro alone does not stop every injection path.

### Formatting Templates

Under **Formatting** in the Advanced tab:

- **Header Template** wraps the section; `{{memories}}` is replaced with joined chunks.
- **Chunk Template** formats each hit; supports `{{content}}`, `{{score}}`, `{{startIndex}}`, and `{{endIndex}}`.
- **Chunk Separator** separates hits.

For example, use a Header Template containing a heading followed by `{{memories}}`, and a Chunk Template of `{{content}}` for simple labeled passages. A recency or keyword-only hit has no vector score and renders `{{score}}` as `n/a`.

**Scores use different metrics:** with basic recall, `{{score}}` is raw vector distance (lower is closer). With Cortex recall, it is the combined ranking score (higher ranks first), which includes semantic relevance, salience, recency, and other signals. A Cortex score of 0.35 does not mean 35% similarity and is not compared directly with the distance cutoff.

Cortex's **Use Long-Term Chat Memory formatting** preserves these templates for raw retrieved chunks. Cortex's formatter still handles consolidations, entities, relationships, and arcs.

## Check What the AI Actually Received

Inspect the resolved prompt in the prompt breakdown / dry-run. Diagnostics report placement as `macro`, `fallback`, or `disabled`; inspect actual text too, especially with conditions.

If `{{memories}}` is empty, check embeddings and chat vectorization, run **Recompile Memories**, wait for background work, and check whether the exclusion window leaves older passages. Turning Cortex off switches retrieval to basic Chat Memory; it does not show that Cortex is required for LTM. See [Troubleshooting Cortex](memory-cortex.md#troubleshooting-cortex) for Cortex-specific checks.
