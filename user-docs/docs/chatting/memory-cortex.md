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

In **Settings → Memory Cortex → Advanced → Advanced settings**, enable consolidation and adjust **Chunks before consolidation**, **Chunks per scene summary**, and **Scene summaries per arc**. These count memory chunks and saved scene summaries, not chat messages. The defaults start consolidation at 40 unconsolidated chunks, summarize 10 chunks at a time, and combine 5 scenes into an arc. After ingestion or a rebuild, Cortex processes due batches and retries pending arcs; it keeps recent chunks below the trigger for later. Lower the trigger for earlier scenes. A chat with 36 messages may still be below the default trigger.

### Replace history with summaries

Under **Settings → Memory Cortex → History replacement**, two independent options control automatic prompt compression. Both are off by default.

| Option | History sent to the model |
| --- | --- |
| **Replace With Consolidated Messages in Context** | Complete source scenes become their saved consolidation summaries. |
| **Replace With Arc Summaries in Context** | Complete source arcs become their saved arc summaries. Other history stays verbatim. |
| **Both on** | Arcs replace their covered scenes; remaining scenes use consolidation summaries; unsummarized messages remain verbatim. |
| **Both off** | No history replacement. Your standard macro/fallback insertion strategy continues unchanged. |

Each replacement occupies the end of its original source span and uses that span’s final user or assistant role. Clear recap boundaries identify completed events as background rather than a new request. Covered scene summaries and raw chunks are not repeated through local recall, and overlapping arc context is suppressed. Entity, relationship, color, and linked-chat context can still be supplied separately.

This changes only the outgoing prompt: saved messages remain intact, and synthetic recaps never feed back into Cortex ingestion. Recap text is literal, without macro expansion or copied reasoning/attachments. The current turn and any explicitly anchored context remain verbatim. Message limits apply before replacement; token-budget clipping can still remove older summaries afterward. Missing, hidden, excluded, noncontiguous, or partially selected sources cause the summary to be skipped. Enable consolidation to create summaries; existing saved summaries can be used even if further consolidation is disabled. Inspect the assembled prompt to see the resulting history.

**Prompt assembly reads cached Cortex memory passages and saved graph context**, rather than waiting for a fresh vector query on every send. When the conversation advances, it rechecks cached passages against the recent-message exclusion window and regeneration target. Saved entities, relationships, arcs, and character colors can be used even with a cold vector cache. Basic Chat Memory can supply passages alongside graph context while Cortex retrieval warms in the background. Enabling Cortex alone does not create context: the chat still needs relevant saved records and the corresponding injection settings enabled.

## Sidecar LLM

An embedding model creates search vectors. A **sidecar LLM** extracts or summarizes information. They are different connections and workloads; enabling embeddings does not configure a sidecar.

In **Settings → Memory Cortex**, choose a sidecar **Connection** and **Model**, then check extraction mode, salience mode, and **AI summaries**. The picker includes built-in LLM connections and providers from enabled [Spindle extensions](../extensions/index.md#extension-provided-ai-providers).

The sidecar can assist with entities/facts, relationships, importance, color attribution, and consolidation. **Chunks per request** batches analysis; **Parallel requests** controls rebuild concurrency; **Requests per minute** throttles starts (0 disables throttling). **Max output tokens** must accommodate the batch's structured response and, for thinking models, reasoning tokens. Increase this limit or lower reasoning effort if a response ends with `finish_reason: "length"`. Consolidation uses this generation budget while requesting the shorter configured summary length. This makes additional model requests, including on rebuild; it is not necessarily one call per chunk.

The chat's Cortex bar appears as soon as you request a rebuild, including time spent queued or preparing. It shows processed chunks, completed/queued batches, elapsed time, and each active batch's state. Sidecar generation streams internally: **Thinking** appears when the provider sends reasoning, and **Responding** when text or tool arguments arrive. **Reviewing** identifies candidate review through the Decision API, which the current integration reads as a single JSON result. A batch remains active through review and saving; receiving an extraction response alone does not complete it. Progress resumes from server snapshots when you reopen or reconnect to the chat. Streaming activity does not expose reasoning text in the bar or save incomplete extraction results.

### Failure Handling and Fallback Connections

Extraction/query work and memory summarization have independent connection chains. Each tries primary, secondary, and additional fallbacks in order, once per connection. Each connection keeps its own model and credentials.

After the chain fails:

- **Heuristic fallback** permits heuristic analysis; failed AI consolidation can use extractive summaries.
- **AI Only — skip chunk, retry on warmup** avoids persisting the failed chunk's analysis and leaves it for a later warmup.

**Sidecar Timeout** bounds each call. AI Only with an unavailable sidecar can leave analysis incomplete instead of filling the graph with heuristics.

### Optional Candidate Review

In **Advanced → Candidate review**, enable **Review memory candidates** and explicitly select a **Decision connection**. You must first create a Decision connection in Connections to enable this option. Review is off by default, no connection is selected automatically (including your default Decision connection), and it remains inactive until you choose a connection. Generative LLMs cannot review candidates. Review covers heuristic, AI and provisional entity proposals, relationships, proposed aliases and character color attributions before saving, and adds model requests, including during rebuilds.

The model override is optional; leaving it empty uses the explicitly selected connection's saved default without filling in the override. Decision review also works with heuristic extraction and importance scoring. AI extraction, fact curation and summaries still use the generative sidecar. Existing generative reviewer settings are disabled and cleared; existing Decision reviewer selections are preserved.

A clear first appearance qualifies for entity tracking; a character or other named entity does not need repeated mentions, a major event or a relationship. Review receives unambiguous first/last-name hints for configured and established characters so a short reference can support their full canonical name. These hints do not automatically create saved aliases. After updating from older review rules, rebuild Cortex for affected chats to recover omitted entities; enabled warmup also detects the changed review version.

A multi-character card uses its shared display label for message routing. Explicitly coordinated names such as “Pulchra Fellini and Jane Doe” provide separate identity hints; the shared label is not an alias for either character. Extraction uses local names, narration, dialogue and viewpoint in any POV to assign facts and relationships. It leaves ambiguous attribution unresolved. Rebuild an affected chat to replace older combined entries from passage evidence.

**Minimum confidence** defaults to 0.8. Both the chosen answer's probability and its confidence must meet the threshold; otherwise that candidate is deferred. This is a retention threshold, not a measured guarantee of accuracy. **Review timeout** is capped at 30 seconds per request; **Requests per minute** limits Decision request starts (0 disables throttling).

A failed or incomplete review saves no new graph or salience results for that chunk and leaves it pending for a later warmup or rebuild. A complete review can defer individual candidates; those candidates are omitted while the chunk completes. Review failures do not fall back to unreviewed persistence. Failed or uncertain review of a dormant relationship leaves it dormant with pending evidence.

Normal logging uses one compact review summary per chunk, with warnings and errors always visible. To investigate extraction or review issues, set `LUMIVERSE_CORTEX_DEBUG=1` in the backend environment and restart. This enables request/response traces and detailed candidate/fact diagnostics.

In debug mode, when entity candidates are deferred, the backend logs an `entity_review` line with the configured threshold, candidate IDs, original choices, confidence and selected probabilities. `deferred_by` distinguishes an explicit model deferral (`model`), a host threshold deferral (`threshold`), and an unusable answer (`invalid_answer`). This line excludes character names and passage text.

`relationship_review` reports the same review details for proposed relationships. `fact_attribution` reports validated fact proposals, matched/unmatched subjects, the passage's importance and configured threshold, and applied entity/fact links. A single fact can attach to multiple named subjects. These diagnostics contain counts and IDs rather than passage text. They help distinguish an empty extraction from rejected or deferred relationships and facts omitted by subject matching or importance filtering.

If a Decision response contains an individually invalid answer, Cortex keeps the valid answers and retries only the invalid questions once, using the same connection and confidence threshold. Answers that remain invalid are explicitly deferred: new candidates are omitted, and existing records are preserved while the chunk completes. Debug logs include the affected candidate ID and, for invalid probability totals, the sum and option count. Normal warnings report only how many answers need retry or deferral. Missing/foreign answer IDs, invalid response metadata, authentication failures and caller cancellation still stop ingestion. Probabilities are never automatically normalized.

**Prune Graph** also reviews existing records against historical excerpts. Manually edited entities and their manually edited relationships are preserved. Inspect the results; model review can still make mistakes. Reviewer configuration changes invalidate prior chunk coverage so the next warmup can rebuild it; changing a connection's default model alone requires a manual rebuild.

Passage-wide facts now attach only to approved entities explicitly named in each fact, including accepted aliases. Facts with an ambiguous subject are omitted. Stored fact metadata retains source chunk IDs and short evidence excerpts. When Fact Auto-Pilot is enabled, it selects from the full set of source facts before retention trims overflow, preserving their text, importance and branch tags.

## Memory Panel

| Tab | Contents and controls |
|-----|-----------------------|
| **Entities** | Names, types, descriptions, aliases, facts, status, mentions, emotional profiles. Each collapsed card shows its fact count. Edit mistakes or delete individually/in bulk. |
| **Colors** | Character color attributions and confidence; supplies `{{characterColors}}` |
| **Stats** | Total/vectorized chunks, entities, relationships, consolidations, salience. Click cards to inspect records. Also contains the per-chat Cortex toggle. |
| **Links** | Attach vaults/interlinks and manage the Vault Library |

Cortex preserves complete character and persona names, including names such as “Still in Love,” lowercase particles, accents and apostrophes. It removes explicit card decorations and separate metadata segments such as `LIVE:`, `| Modern AU` or a subtitle introduced by a spaced hyphen. The stored author label identifies the same participant across extraction, review, relationship endpoints and fact attribution; it is not a second entity. Rebuild an affected chat after updating to replace automatically generated records with shortened names or attached card subtitles.

Stored records are not this generation's retrieved context. Seeing entities here does not mean every entity will appear in `{{entities}}`.

### Character Colors

Cortex reads colors from `<font color="...">` and `<span style="color: ...">` markup. Following the roleplay formatting convention, `*...*`, `_..._`, `<i>`, `<em>` and configured thought delimiters identify the **thought/italic channel**, including when they wrap the color tag. Quotes inside that channel remain thoughts. Other quoted text is speech, and plain descriptive text is narration. Italics indicate formatting; they do not prove a character's mental state.

For example, both `<font color="#abc">*"I should leave."*</font>` and `*<font color="#abc">"I should leave."</font>*` produce thought color `#aabbcc`. A character can use the same color for both speech and thoughts; Cortex keeps those usages separately. `{{characterColors}}` supplies speech and thought guidance. Narration remains visible in the Colors tab.

Ownership uses local attribution and message context. A name addressed inside dialogue is not automatically the speaker, and a shared color does not uniquely identify a character. With candidate review enabled, the reviewer must approve each color, usage and owner claim independently. Unsupported colors and usage types are discarded, and heuristic plus sidecar detections count as one observation per color/owner/usage in a chunk.

A standalone first-person thought continues its message's established first-person viewpoint, including sentences beginning with “My.” Other characters mentioned elsewhere in the message do not remove that evidence. Explicit attribution to another thinker takes precedence. Colors for newly extracted characters are eligible after their identity and color claim pass review.

After updating from older color detection behavior, rebuild Cortex for an existing chat to replace its old color attributions. Warmup also detects the changed rules when enabled.

### Relationship References

AI extraction resolves relationship endpoints from names, message prefixes, aliases and unambiguous pronouns. It requires evidence for the connection; sharing a scene or a room alone does not establish a partnership. Known endpoints omitted from the entity extraction list can still be proposed for review. Rejected or deferred endpoints cannot acquire new relationships, and new aliases redirect endpoints only after approval when review is enabled.

The **lover** type includes supported love interests, romantic affection, courtship and established partners. Its label records the supported scope, such as “romantic interest”; it does not imply marriage, exclusivity, sex or reciprocal feelings. A confession or clearly romantic action can establish a connection before a formal partnership. Room-sharing alone cannot.

Cortex also proposes relationships from clear first-person romantic statements and actions, such as “I have a crush on you” or “I kissed you,” even when AI extraction returns an empty relationship list. Stored message roles and current message prefixes identify the participants. Ambiguous group addressees, negated/hypothetical statements and third-party dialogue do not qualify for this extra detection. With candidate review enabled, these proposals still require approval at the configured confidence threshold.

Directed types describe the source's role relative to the target: a parent points to their child, a mentor to their student, and a subordinate to the superior they serve. Heuristic extraction remains limited to supported text patterns; Decision review judges supplied candidates. Arbitration logs show relationship extraction, proposal and approval counts to distinguish missing detections from rejected or deferred proposals.

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

Chat Memory's **Maximum vector distance** also gates Cortex, vault, and interlink recall before ranking. Lower distances are closer; a 0.35 distance passes a 0.6 maximum. Cortex's displayed **Score** is its separate combined ranking score, not the distance or a similarity percentage. See [retrieval controls](memory.md#retrieval-and-query) for the distinction. This gate does not affect automatic history replacement or saved entity/relationship context.

## Troubleshooting Cortex

| Symptom | What to check |
|---------|---------------|
| `{{memories}}` works with Cortex off | Expected: basic recall is independent. Check Cortex preparation/cache separately. |
| `{{cortexActive}}` says `no` while enabled | The macro checks available Cortex content. Check global/per-chat switches, saved records, and entity/relationship/arc injection settings. A cold vector cache alone does not hide saved graph context. |
| Stored entities exist but `{{entities}}` is empty | The macro uses entities selected for this prompt's recent conversation. Check entity tracking, entity injection, and whether the conversation mentions their names or aliases. |
| `{{arc}}` is empty | Check consolidation/arc injection and whether enough history exists for an arc. A saved Loom Summary does not populate this macro. |
| Everything is heuristic after adding a sidecar | Check extraction/scoring modes, credentials/model, failure policy, and rebuild status. Heuristic fallback can legitimately write heuristic records. |
| No old passages | Check embeddings, **Vectorise chat messages**, chunk/vector counts, exclusion window, and shared Injection Strategy. |
| Conditional block is empty | Check condition/macros in the resolved prompt. Try a simple `{{memories}}` block to distinguish combined recall from Cortex-only output. |

Inspect the prompt breakdown / dry-run for exact text and placement (`macro`, `fallback`, or `disabled`). If rebuilding has finished but output still fails, report app version, mode, global/per-chat switches, chunk/vector counts, sidecar status, and affected preset block. These checks distinguish configuration issues from regressions; a missing macro result alone does not establish the cause.
