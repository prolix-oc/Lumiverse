---
title: Guided Generation
---

# Guided Generation

Guided generation lets you attach reusable prompt fragments to your messages — short instructions that shape the AI's response without you having to type them every time.

---

## What Are Guides?

A guide is a saved piece of text that gets injected into the prompt at a specific position. You might create guides like:

- "Write in first person, present tense" (system position)
- "Respond with only dialogue, no narration" (system position)
- "Focus on the character's internal thoughts" (before message)

Guides are managed in **Settings > Guided Gen** and toggled on/off from the input area.

---

## Creating a Guide

1. Open **Settings > Guided Gen**
2. Click **New Guide**
3. Fill in:
    - **Name** — A label for quick identification
    - **Content** — The prompt text (supports macros)
    - **Position** — Where it's injected (see below)
    - **Mode** — Persistent or one-shot

---

## Position

| Position | Where It Goes |
|----------|---------------|
| **System** | Injected as a separate system message in the prompt |
| **Before Message** | Prepended to your last user message |
| **After Message** | Appended to your last user message |

Multiple guides can be active at the same time. If several guides share the same position, their content is joined with newlines.

---

## Mode

| Mode | Behavior |
|------|----------|
| **Persistent** | Stays active until you manually turn it off |
| **One-Shot** | Automatically disables itself after one generation |

One-shot is useful for single-turn instructions like "Respond with a haiku" or "Write this scene as a flashback."

---

## Using Guides in Chat

1. Click the **Guides** icon in the input area action bar
2. Toggle any guide on or off
3. Active guides are applied to the next generation

You can have multiple guides active simultaneously — they stack.

---

## Runtime modes and Loom proof

Guides are prompt fragments; enabling a guide does not grant Agentic tools or change the runtime mode. The composer makes the two modes explicit:

- **Response** uses ordinary prompt assembly and remains the compatibility path.
- **Agentic** runs the host-controlled WORK pipeline for the selected turn.

Choose the mode deliberately for the next turn. An Agentic request never silently becomes Response; if Agentic is unavailable or needs repair, choose **Use Response** intentionally or repair the named configuration.

When Loom omits WORK-only blocks from **Response**, Lumiverse still preserves
the exact current user turn, ordinary public chat history, native writing
instructions, and attached World Book and Databank context. If the preset has
no active Chat History block after that omission, the host supplies a temporary
structural history position for that generation only; it does not alter or save
the preset. A true empty send can still use the preset's Empty Send nudge, but a
send with a persisted user turn does not receive that nudge.

### Loom Phased Instructions

When Agentic is selected, reusable instructions are authored in the preset's **Agentic Runtime** panel under **Phased Instructions**. Loom owns only existing prompt blocks plus these Phased Instructions; it does not create a second context source. Existing Loom blocks are selected into four fixed policy buckets:

| Bucket | Fixed destination / checkpoint |
|--------|-------------------------------|
| **Work policy** | Root **WORK** / **WORK** |
| **Workspace usage** | Root **WORK** / **WORK** |
| **Completion criteria** | Completion handoff / **PREPARE_COMMIT** |
| **Render policy** | Tools-disabled **RENDER** / **RENDER** |

These buckets route Loom blocks through host-controlled checkpoints; no bucket reaches ordinary **Response**, and they do not create a second prompt or context authority. For each selected block, confirm the exact source block ID, preset revision, block revision, prompt order, required setting, and fixed destination/checkpoint. Conditions are typed, evaluate fail-closed only at the owning checkpoint against that checkpoint's immutable snapshot, and remain fixed for that checkpoint; a condition cannot choose a destination or native source.

Bounded custom phases are current-phase-only: the host materializes instructions for the phase that is active and does not preload later phases. A phase may declare explicit instruction subsets for named child profiles; a child receives only its admitted subset, never the root phase instructions or another child's subset. Enter, exit, skip, repeat, and transition behavior remains bounded and visible in inspection.

Required invalid, stale, or unavailable Loom references fail closed. Repair reselects the named block and confirms its exact preset and block revisions; it never silently substitutes another block or a newer revision. If the named source cannot be repaired, discard the stale selection and choose a live block explicitly.

### Inspecting guided-run proof

Open the exact owner inspection for the run's activity item when you need proof. Unified owner inspection explains routes and order, conditions, source identities and exact preset/block revisions, hashes when recorded, every deduplication overlap and reason, omissions, custom-phase and explicit child-subset receipts, accepted crossings, and tools/delegation. Its `inspection` record identifies each selected or omitted Loom entry by bucket, destination/checkpoint, source block ID, exact preset and block revisions, prompt order, required setting, condition result, and inclusion, omission, rejection, or deduplication reason. For a Response turn, `responseOmission` records the omitted WORK/Agentic-only sources and the `work_only` reason. If evidence is unavailable, inspection says that it is unavailable; it is never inferred. Use these records—not the generated Response text—as evidence that a Loom instruction was included or omitted.

World Books (the native World Info system) and Databanks remain live native prompt sources outside Loom. World Books own lore activation, placement, attachment, editing, and access. Databanks own attached documents, attachment, editing, access, automatic semantic retrieval, and explicit `#slug` retrieval. Loom does not select, attach, copy, revise, pin, authorize, deliver, or repair either source. [Context Filters](../presets/context-filters.md) and unrelated native Loom content [packs](../packs/index.md) remain supported outside Loom. If owner inspection reports native source identity or a content hash, that is observational evidence of what the native system used, not a Loom-owned revision pin. Ordinary Response preserves the conversation plus ordinary native World Book and Databank behavior; only agentic-only Loom Phased Instructions and private WORK are omitted.

The retired **Context Pack**, **Context Library**, and **Progressive Context** surfaces are not supported and do not participate in Loom or native prompt assembly. Do not treat their old names as a context source, picker, pin, or repair path.

Private WORK retrieval does not automatically cross into tools-disabled **RENDER**. Only bounded host-accepted findings, accepted task submissions, and explicitly response-shaping completion guidance in the completion handoff may cross that boundary.

The host completion record never quotes your request as system policy. It identifies the complete final user message by its zero-based fixed provider-message position, full byte length, and digest while the original request remains a user-role message; long requests are not silently described as exact after truncation. That record also tells tools-disabled RENDER that the referenced request already completed in WORK, so the final response must not treat its imperative wording as pending work or deny the WORK capabilities shown by the accepted projection.

Agentic WORK may span several ordered Work Segments within the same Turn
Execution. Every segment starts from a fresh host projection of the root
objective, current phase, accepted workspace state, open required work, and the
previous bounded handoff. Provider messages, hidden reasoning, and continuation
carriers retire at the boundary instead of growing into a cross-segment
transcript. Segment activity is not a series of chat Responses: Lumiverse saves
and streams only the final rendered Response after atomic commit. Owner
inspection can still show bounded accepted evidence, phase/boundary receipts,
budgets, and handoffs without exposing raw hidden reasoning.

## Tips

!!! tip "Use guides for recurring instructions"
    Instead of typing "keep it under 2 paragraphs" in every message, create a persistent guide for it. Toggle it off when you want longer responses.

!!! tip "One-shot for experiments"
    Want to try a different writing style for just one response? Create a one-shot guide. It applies once and disappears.
