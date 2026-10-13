---
title: Memory Cortex
---

# Memory Cortex

Memory Cortex adds entity tracking, relationship records, narrative importance scores, emotional recall, and scene/arc consolidation to chat-history recall. It is optional: [Chat Memory / LTM](memory.md) works with Cortex disabled. [Summary](loom-summary.md) is a separate saved overview, not a Cortex consolidation.

## Where Everything Lives

| Location | What you do there |
|----------|-------------------|
| **Settings → Embeddings** | Configure embeddings and enable **Vectorise chat messages** |
| **Settings → Advanced → Long-Term Chat Memory** | Shared chunking, exclusion, query settings, templates, and Injection Strategy; Conservative/Balanced/Aggressive/Manual modes |
| **Settings → Memory Cortex** | Global switch, Simple/Standard/Advanced modes, sidecar connections, formatter, ranking, and consolidation |
| Sidebar **Memory** | Inspect/edit this chat's entities, colors, chunks, relationships, consolidations, and links |
| Sidebar **Memory → Stats** | Enable/disable Cortex for this chat; the global switch must also be on |
| Chat input bar quick menu → **Recompile Memories** | Prepare Chat Memory and, when enabled for the chat, Cortex |

Cortex's **Advanced** mode is inside the Memory Cortex tab. **Settings → Advanced** holds the shared LTM controls. These are different places.

## Getting Started

1. Set up [Chat Memory](memory.md#set-up-chat-memory-without-cortex), including a tested embedding connection and **Vectorise chat messages**.
2. In **Settings → Memory Cortex**, turn on **Enable Memory Cortex**. Check the per-chat toggle under **Memory → Stats** if Cortex is disabled for this chat.
3. Choose **Simple** or **Standard**. Heuristic entity/importance analysis does not require a sidecar LLM.
4. Add `{{memories}}` to an enabled system block in your active preset for combined memory context. Keep `{{loomSummary}}` in a separate block if you also use Summary.
5. Use **Recompile Memories** from the chat input bar. Cortex settings also provide **Rebuild** for the open chat. Wait for processing, inspect **Memory → Stats**, then inspect the resolved prompt.

**Warm Memory Cortex when opening a chat** is opt-in. It prepares state on chat open; manual recompilation works while it is off. Chat Memory's warmup toggle is separately located in Settings → Advanced.

### What the Modes Actually Change

| Mode | Behavior |
|------|----------|
| **Simple** | Heuristic extraction/scoring, fused ranking, emotional resonance, diversity selection, and entity context. Consolidation, relationship injection, and arc injection are off. |
| **Standard** | Heuristic extraction/scoring plus relationship/arc injection and consolidation. Selecting it enables sidecar consolidation when a sidecar connection is already configured. |
| **Advanced** | Keeps your current configuration and exposes detailed controls. It does **not** automatically enable LLM extraction or select a connection. |

Choosing a sidecar connection can switch extraction/scoring to sidecar mode and enable AI summaries. Check those controls after choosing a connection or switching modes; the mode name alone does not establish which model is doing the work.

## How Cortex Processes and Recalls History

**Analysis** enriches chunks with salience (importance), emotional tags, entities, facts, and relationships. Heuristics use text patterns; a configured sidecar can analyze these with an LLM. Both can misidentify names or infer incorrect facts, so review the Memory panel.

**Retrieval** combines semantic relevance with configured signals such as importance, recency, reinforcement, emotional resonance, and entity relevance. Diversity selection avoids closely clustered passages. Core-memory protection affects decay/ranking; it does not guarantee inclusion in every prompt.

**Consolidation** groups older chunks into scene summaries, then scene summaries into arcs when thresholds are reached. Without AI summaries it extracts source text; with a sidecar it can generate summaries. Inspect these under **Memory → Stats → Consolidations**. They do not update `{{loomSummary}}`.

**Prompt assembly reads usable cached Cortex results**, rather than waiting for a fresh query on every send. On a cold cache or an unusable result, it falls back to basic Chat Memory while Cortex work runs in the background. Basic Chat Memory also uses a cache, so a cold start can initially have no recall. Enabling Cortex does not guarantee entities or arcs in the very next prompt.

## Sidecar LLM

An embedding model creates search vectors. A **sidecar LLM** extracts or summarizes information. They are different connections and workloads; enabling embeddings does not configure a sidecar.

In **Settings → Memory Cortex**, choose a sidecar **Connection** and **Model**, then check extraction mode, salience mode, and **AI summaries**. The picker includes built-in LLM connections and providers from enabled [Spindle extensions](../extensions/index.md#extension-provided-ai-providers).

The sidecar can assist with entities/facts, relationships, importance, color attribution, and consolidation. **Chunks per request** batches analysis; **Parallel requests** controls rebuild concurrency; **Requests per minute** throttles starts (0 disables throttling). **Max output tokens** must accommodate the batch's structured response. This makes additional model requests, including on rebuild; it is not necessarily one call per chunk.

### Failure Handling and Fallback Connections

Extraction/query work and memory summarization have independent connection chains. Each tries primary, secondary, and additional fallbacks in order, once per connection. Each connection keeps its own model and credentials.

After the chain fails:

- **Heuristic fallback** permits heuristic analysis; failed AI consolidation can use extractive summaries.
- **AI Only — skip chunk, retry on warmup** avoids persisting the failed chunk's analysis and leaves it for a later warmup.

**Sidecar Timeout** bounds each call. AI Only with an unavailable sidecar can leave analysis incomplete instead of filling the graph with heuristics.

**Arbitrates Heuristics** lets successful sidecar analysis reject or rename heuristic candidates. **Grades Existing Records** can remove invalid existing entities; user-edited entities are protected from that grading. Inspect the records rather than assuming every fact is correct.

## Memory Panel

| Tab | Contents and controls |
|-----|-----------------------|
| **Entities** | Names, types, descriptions, aliases, facts, status, mentions, emotional profiles. Edit mistakes or delete individually/in bulk. |
| **Colors** | Character color attributions and confidence; supplies `{{characterColors}}` |
| **Stats** | Total/vectorized chunks, entities, relationships, consolidations, salience. Click cards to inspect records. Also contains the per-chat Cortex toggle. |
| **Links** | Attach vaults/interlinks and manage the Vault Library |

Stored records are not this generation's retrieved context. Seeing entities here does not mean every entity will appear in `{{entities}}`.

## Vaults & Interlinks

A **vault** is a frozen snapshot of a chat's memory state for other chats to consume. Use it for a finished campaign or shared backstory. Changes to the original chat do not keep updating the snapshot. Vault embeddings can be rebuilt after changing embedding configuration.

An **interlink** reads another chat's evolving memory. It can share entities, relationships, and optionally chunks. Links can be directional or bidirectional; the other chat receives your memory only if configured that way.

In **Memory → Links**, choose **Add Link**, choose **Vault** or **Interlink**, then select the vault or target chat. The **Vault Library** lists saved vaults and consumers. Linked context is retrieved/cached separately and can appear in combined `{{memories}}` output; it is not pasted into every prompt in full.

## Put Cortex in the Prompt

### Combined Context

Use one enabled system block before Chat History:

```text
{{memories}}
```

With a usable Cortex result, this supplies combined formatted recall, selected graph/consolidation context, and color guidance. If Cortex falls back to basic recall, it supplies that instead. This is a useful starting point for both systems.

### Individual Cortex Macros

For a custom layout, use individual macros in enabled blocks:

```text
{{if {{cortexActive}} = yes}}
{{entities}}
{{relationships}}
{{arc}}
{{characterColors}}
{{/if}}
```

| Macro | Returns |
|-------|---------|
| `{{entities}}` | Selected entity snapshots with facts/relationships; `{{entities::3}}` limits to three |
| `{{entityFacts::Name}}` | Facts for a case-insensitive name match in **retrieved entity context**, not a search of every stored entity |
| `{{relationships}}` | Selected relationship edges |
| `{{arc}}` | Cortex arc text, not Loom Summary |
| `{{memorySalience}}` | One retrieved passage with highest salience, not the complete memory section |
| `{{characterColors}}` | Available character color guidance |
| `{{cortexActive}}` | `yes` when this prompt has Cortex content; otherwise `no`. Not simply the master toggle's value. |
| `{{entityCount}}` | Retrieved entity count, not total stored entities |

Cortex macros return empty content when their data is unavailable. With Cortex off, `{{memories}}` can still work while these are empty.

### Automatic Injection and Duplicate Content

Usable Cortex or linked memory can be inserted as a system message before Chat History if no memory content macro owns placement, **even when shared Injection Strategy is Macro only**. **Disabled** stops that combined injection and `{{memories}}`; it does not stop standalone Cortex macros.

Any applicable enabled block containing `{{memories}}` (or aliases), `{{memoriesRaw}}`, `{{entities}}`, `{{entityFacts}}`, `{{relationships}}`, `{{arc}}`, `{{memorySalience}}`, or `{{characterColors}}` owns placement and suppresses combined fallback. Status/count macros alone do not.

A block containing only `{{entities}}` therefore does not also receive the rest of the combined section automatically. Add the other content you want explicitly. Conversely, `{{memories}}` alongside individual macros can repeat graph/arc content already included in the combined section.

Macro presence is detected in applicable block source before conditions finish resolving. A false condition around a content macro can suppress fallback even when no memory text is output. Inspect the resolved prompt, not just the diagnostics label.

## Formatting and Retrieval Controls

**Use Long-Term Chat Memory formatting** in Cortex settings preserves the Advanced tab's templates for raw chunks. Consolidations, entities, relationships, and arcs still use the selected Cortex formatter. Turning it off uses Cortex formatting for the combined section.

| Formatter | Style |
|-----------|-------|
| **Shadow** | Prose-style continuity context with instructions against reciting it |
| **Attributed** | Memories presented with character perspective and temporal distance |
| **Clinical** | Factual bullets |
| **Minimal** | Memory passages only; omits the formatter's entity/relationship/arc sections |

**Context Token Budget** controls Cortex formatting. Choose **Advanced** mode and expand detailed settings to tune emotional resonance, diversity, entity/relationship/arc injection, consolidation thresholds, decay/core-memory protection, and pruning. Pruning can archive stale single-mention entities; protected terms help retain fantasy names extraction might filter.

## Troubleshooting Cortex

| Symptom | What to check |
|---------|---------------|
| `{{memories}}` works with Cortex off | Expected: basic recall is independent. Check Cortex preparation/cache separately. |
| `{{cortexActive}}` says `no` while enabled | Check global/per-chat switches, recompile, and wait for background processing. Cold-cache prompts can use basic recall while Cortex warms. |
| Stored entities exist but `{{entities}}` is empty | The macro uses this prompt's selected cached context. Check entity injection and resolved output. |
| `{{arc}}` is empty | Check consolidation/arc injection and whether enough history exists for an arc. A saved Loom Summary does not populate this macro. |
| Everything is heuristic after adding a sidecar | Check extraction/scoring modes, credentials/model, failure policy, and rebuild status. Heuristic fallback can legitimately write heuristic records. |
| No old passages | Check embeddings, **Vectorise chat messages**, chunk/vector counts, exclusion window, and shared Injection Strategy. |
| Conditional block is empty | Check condition/macros in the resolved prompt. Try a simple `{{memories}}` block to distinguish combined recall from Cortex-only output. |

Inspect the prompt breakdown / dry-run for exact text and placement (`macro`, `fallback`, or `disabled`). If rebuilding has finished but output still fails, report app version, mode, global/per-chat switches, chunk/vector counts, sidecar status, and affected preset block. These checks distinguish configuration issues from regressions; a missing macro result alone does not establish the cause.
