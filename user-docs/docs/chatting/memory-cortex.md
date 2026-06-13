# Memory Cortex

Memory Cortex is an advanced memory layer that sits on top of [Long-Term Memory](memory.md). While basic long-term memory retrieves relevant text chunks by similarity, the cortex understands *what happened* — tracking characters, relationships, emotional beats, and narrative arcs across your entire conversation.

---

## What Does It Add?

| Feature | Long-Term Memory | Memory Cortex |
|---------|:---:|:---:|
| Retrieve relevant past passages | Yes | Yes |
| Track named characters, locations, factions | - | Yes |
| Map relationships between entities | - | Yes |
| Score narrative importance (salience) | - | Yes |
| Detect emotional tones | - | Yes |
| Summarize story arcs | - | Yes |
| Attribute font colors to characters | - | Yes |

Memory Cortex doesn't replace long-term memory — it enhances it. With the cortex enabled, retrieved memories are ranked using narrative importance, emotional resonance, and entity relevance in addition to raw text similarity.

---

## Getting Started

### 1. Enable the Cortex

Open **Settings > Memory Cortex** and flip the master toggle on.

### 2. Pick a Preset

Three presets configure the cortex for different use cases:

| Preset | Entity Tracking | Salience Scoring | Consolidation | Sidecar LLM | Best For |
|--------|:---:|:---:|:---:|:---:|------|
| **Simple** | Heuristic | Heuristic | Off | Off | Casual chats, low overhead |
| **Standard** | Heuristic | Heuristic | On | Off | Most roleplay (recommended) |
| **Advanced** | Heuristic + LLM | Heuristic + LLM | On | On | Long epics, maximum accuracy |

!!! tip "Start with Standard"
    Standard gives you entity tracking, salience scoring, and consolidation using zero-cost heuristics — no extra API calls. You can always upgrade to Advanced later.

### 3. Rebuild Existing Chats

If you enable the cortex on a chat that already has history, click **Rebuild** in the Memory Cortex settings. This processes all existing chunks through the cortex pipeline. New messages are processed automatically going forward.

---

## How It Works

Every time a message is sent, the cortex processes the corresponding chunk through several layers:

### Salience Scoring

Each chunk gets a narrative importance score (0.0 to 1.0) based on:

- **Emotional signals** — grief, joy, tension, intimacy, betrayal, and more
- **Narrative flags** — first meetings, deaths, promises, confessions, departures
- **Dialogue content** — commitments, revelations, emotional declarations
- **Character actions** — named characters doing emotionally significant things
- **Milestone markers** — "for the first time", "nothing would be the same"
- **Information density** — scenes with many proper nouns and new facts

High-salience memories resist decay over time. Pivotal moments (score above 0.7 or carrying narrative flags like `death` or `promise`) are protected as **core memories** — they decay 5x slower and never drop below a 0.5 retrieval floor.

### Entity Tracking

The cortex extracts and tracks named entities from your chat across six types:

- **Characters** — detected by verb adjacency ("Melina sighed"), dialogue attribution, interaction patterns
- **Locations** — detected by suffixes ("Sixth Street"), locative phrases ("arrived at Dustwell")
- **Factions** — detected by collective nouns ("Sons of Calydon"), business suffixes ("PubSec")
- **Items** — detected by weapon/vehicle verbs ("wielding the Starblade")
- **Concepts** — proper-noun ideas, magic systems, doctrines, named phenomena
- **Events** — named happenings (battles, ceremonies, festivals) that recur across the story

Each entity accumulates facts, emotional associations, and a salience profile over time. The entity graph handles aliases automatically — if a character named "Pulchra Fellini" is sometimes called "Pulchra" or "Pul", those references are resolved to the same entity.

You can browse entities in the **Memory panel** (sidebar > Memory > Entities tab). Delete any that were incorrectly extracted.

### Relationship Mapping

When two named entities appear in the same chunk, the cortex analyzes their interaction:

- **Verb-mediated** — "Melina protected Caesar" (ally, positive sentiment)
- **Relational nouns** — "Melina's brother" near "Caesar" (sibling)
- **Coordinated action** — "Melina and Caesar fought together" (ally)
- **Terms of address** — endearments or hostile language in dialogue
- **Physical proximity** — two characters described near each other

Relationships are reinforced each time they're observed, building a strength score over time.

### Consolidation

As your chat grows, older chunks are compressed into summaries:

- **Scene summaries** (Tier 1) — groups of chunks consolidated into a single paragraph capturing key events
- **Story arcs** (Tier 2) — groups of scene summaries compressed into high-level arc descriptions

Consolidation triggers automatically when enough unconsolidated chunks accumulate (configurable threshold). This keeps the memory footprint bounded while preserving narrative continuity.

You can view consolidations in the **Memory panel** (sidebar > Memory > Stats > Consolidations).

### Emotional Recall

When you generate a new message, the cortex analyzes the emotional tone of recent messages and boosts retrieval of memories with matching emotions. A sad scene naturally surfaces memories of past grief and loss. A tense confrontation recalls previous conflicts.

This "Proustian recall" works alongside semantic similarity — memories that are both topically relevant *and* emotionally resonant score highest.

---

## Sidecar LLM (Tier 2)

For maximum accuracy, you can assign a secondary LLM connection to assist the cortex. This sidecar model handles:

- **Deeper entity extraction** — catches entities the heuristic misses
- **Better relationship detection** — understands implied relationships
- **Calibrated salience scoring** — judges narrative importance by consequence, not just keyword presence
- **Font color attribution** — identifies which character owns each HTML color tag
- **Key fact extraction** — pulls concrete, memorable facts from each passage
- **Generative consolidation** — produces coherent narrative summaries instead of sentence extractions

### Setting Up a Sidecar

1. In **Memory Cortex settings**, select a **Connection Profile** under the Sidecar section
2. Choose a **Model** (smaller, faster models work well here — the sidecar doesn't need to be creative)
3. Adjust **Temperature** (0.1 recommended for factual extraction)
4. Set **Parallel Requests** to control how many concurrent LLM calls run during a rebuild
5. Set **Requests Per Minute** to throttle the sidecar against your provider's rate limits (0 = unlimited)

!!! note "Sidecar Costs"
    The sidecar makes one LLM call per chunk during live chat, and one per chunk during rebuilds. A chat with 200 chunks would make 200 API calls on rebuild. Choose an inexpensive model for the sidecar to keep costs reasonable.

### Reliability & Retries

The sidecar is wrapped in a small reliability layer you can tune:

| Setting | Description |
|---------|-------------|
| **Fallback** | `heuristic` writes the heuristic result if the sidecar fails; `skip` holds the chunk for reprocessing on the next pass. |
| **Max Retries** | Additional attempts after the first failed call (exponential backoff). |
| **Sidecar Timeout** | Per-call timeout in milliseconds before the call is abandoned. |

### Arbitration

When the sidecar is enabled, two optional behaviors give it authority over heuristic data:

- **Arbitrates Heuristics** — the sidecar reviews each heuristic entity before it is persisted and can reject or rename misidentifications (e.g. discarding common words mistakenly extracted as characters).
- **Grades Existing Records** — periodically re-evaluates already-saved entities and removes ones that have become noise. Useful after a long chat has accumulated mistakes.

If the sidecar call fails and **Fallback** is set to `heuristic`, the heuristic result is used as a safe default.

---

## Memory Panel

The sidebar's **Memory** tab gives you a live view of the cortex data for the current chat. It has four tabs:

### Entities Tab
Browse all tracked entities — characters, locations, items, factions, concepts, events. Each entity card shows:

- Type and status (active, inactive, deceased, destroyed, unknown)
- Mention count and salience average
- Description (auto-populated from first appearance)
- Known facts
- Emotional profile (top emotional associations)
- Aliases

You can select multiple entities and delete them in bulk, or delete a single incorrectly extracted entity directly from this panel.

### Colors Tab
Shows font color attributions — which hex color belongs to which character, with confidence scores. Useful for chats where characters use distinct colors for speech, thought, or narration.

### Stats Tab
Overview of the cortex data:

- Memory chunks (total and vectorized)
- Entities (active and archived)
- Relations between entities
- Consolidations (scene summaries and arcs)
- Salience records (sourced from `heuristic` or `sidecar`)

Click any stat card to drill down into the raw records.

### Links Tab
Manages cross-chat memory sharing — see [Vaults & Interlinks](#vaults-interlinks) below.

---

## Vaults & Interlinks

Cortex memory can be shared between chats in two ways. Both are managed from the **Links** tab in the Memory panel.

### Vaults

A **vault** is a frozen snapshot of a chat's cortex state — its chunks, entities, and relationships — packaged into a reusable, read-only knowledge object. You can attach a vault to any number of other chats so the cortex on those chats can retrieve from it during generation.

Typical uses:

- Bottle a finished campaign into a vault, then start a sequel chat that "remembers" the prior arc
- Build a "world bible" vault from a worldbuilding chat and attach it to every chat set in that universe
- Share canonical character history across roleplay branches without re-pasting it

Vault chunks are stored alongside chat chunks in the embeddings table (`source_type='vault_chunk'`) so semantic search continues to work seamlessly. You can also **rebuild** a vault's embeddings if you change your embedding provider.

### Interlinks

An **interlink** is a live, bidirectional connection between two chats. Each chat can see the other's entities, relationships, and (optionally) chunks in real time. Unlike a vault, an interlink stays in sync — new entities discovered in either chat become visible to the other on the next generation.

Use interlinks when two chats are happening in the same continuity and should share evolving memory (e.g. one chat tracks Character A's POV while another tracks Character B's POV in the same scene).

### Adding a Link

1. Open the **Memory panel** and switch to the **Links** tab
2. Click **Add Link** and choose **Vault** or **Interlink**
3. Pick an existing vault / a target chat (interlinks can be flipped to bidirectional from the same dialog)

The **Vault Library** at the bottom of the tab lists all your saved vaults and the chats currently consuming them. Delete a vault from there when you no longer need it.

---

## Macros

Memory Cortex data is available in your presets through macros. Add these via **Add Prompt > Memory Cortex** in the preset editor:

| Macro | Returns |
|-------|---------|
| `{{entities}}` | Active entity snapshots with facts and relationships |
| `{{entityFacts::Name}}` | Facts about a specific entity (e.g., `{{entityFacts::Melina}}`) |
| `{{relationships}}` | Active relationship edges between entities |
| `{{arc}}` | Current narrative arc summary |
| `{{memorySalience}}` | The single highest-importance memory from retrieval |
| `{{cortexActive}}` | `"yes"` or `"no"` for conditional blocks |
| `{{entityCount}}` | Number of entities in the current context |
| `{{characterColors}}` | Character speech / thought / narration color guidance derived from cortex state |

The standard memory macros (`{{memories}}`, `{{memoriesRaw}}`, etc.) continue to work alongside cortex macros. When the cortex is enabled, `{{memories}}` returns cortex-enhanced results formatted in shadow-prompt style.

!!! important "Cortex memories inject automatically too"
    As with [long-term memory](memory.md), the cortex-enhanced memory section injects whenever the cortex is enabled — the `{{memories}}` macro only controls **where** it lands. Remove the macro and the section still injects as a system message before the chat history. To stop it, disable Memory Cortex (and, if you don't want basic recall either, **Vectorise chat messages**). Note that the standalone cortex macros (`{{entities}}`, `{{relationships}}`, `{{arc}}`, etc.) render *only* where you place them — they have no auto-injection fallback.

---

## Configuration Reference

### Formatter Mode

Controls how retrieved memories are formatted for the prompt:

| Mode | Style |
|------|-------|
| **Shadow** | Prose-register context with "do not recite" instructions (default) |
| **Attributed** | Each memory labeled with source and salience |
| **Clinical** | Bullet-point factual summaries |
| **Minimal** | Raw content, minimal formatting |

### Decay Settings

Memories lose relevance over time through a decay function:

| Setting | Description |
|---------|-------------|
| **Half-Life (turns)** | After this many messages, a memory's recency score halves |
| **Reinforcement Weight** | How much retrieval boosts a memory's score (prevents useful memories from decaying) |
| **Core Memory Threshold** | Salience score above which a memory becomes a protected "core memory" |
| **Core Memory Flags** | Narrative flags that automatically mark a memory as core (e.g., death, promise) |

### Entity Pruning

Keeps the entity graph bounded:

| Setting | Description |
|---------|-------------|
| **Enabled** | Toggle automatic pruning |
| **Stale After (messages)** | Entities not seen for this many messages get archived |
| **Min Confidence** | Minimum extraction confidence to create new entities |

### Protected Terms

The **entity whitelist** lets you specify proper nouns that should always be recognized as entities, even if they look like common words. Useful for fantasy names that might be filtered out.

---

## Tips

!!! tip "Rebuild after changing settings"
    If you change chunking parameters or enable the sidecar, click **Rebuild** to reprocess all chunks. The cortex detects stale data automatically on the next generation, but a manual rebuild ensures immediate freshness.

!!! tip "Delete bad entities early"
    If you spot an incorrectly extracted entity (like a common word being tracked as a character), delete it from the Memory panel. This prevents it from accumulating relationships and facts that pollute the graph.

!!! tip "Pair with Loom Summary"
    The cortex excels at granular recall (specific moments, entity facts, relationships). [Loom Summary](loom-summary.md) provides a structured overview of the whole story. Use both for comprehensive long-term coherence.

!!! tip "Sidecar model selection"
    For the sidecar, prioritize speed and cost over creativity. Models like Gemini Flash, Haiku, or GPT-4o-mini work well — the sidecar does structured extraction, not creative writing.

!!! tip "Check the Stats tab"
    The Stats tab shows whether salience records are sourced from "heuristic" or "sidecar". After a rebuild with a sidecar configured, you should see "sidecar" entries. If everything still shows "heuristic", check that your sidecar connection is configured correctly.
