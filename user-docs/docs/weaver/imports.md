---
title: Imports
---

# Imports

The Import door brings existing material into the studio: a character card you downloaded, or a worldbook you've built up elsewhere. An import isn't a separate pipeline — it pre-fills the Bible from your file and then runs the **same** stages as any build, so everything in [Studio Workflow](studio-workflow.md) applies. The difference is where the material comes from: instead of a dream, the Weaver reads your file.

The headline use case: **rebuild a card to studio quality.** Most downloaded cards are thin in exactly the ways the Weaver exists to fix — vague descriptions, no real tension, a voice that could belong to anyone. Importing one reverses it into a structured Bible, shows you what's actually there and what's missing, interviews you about _only the gaps_, and re-renders studio-grade fields — while the original stays untouched in your library as a fallback.

---

## Bringing a File In

**New → Import** opens the import pane. Drop a file on the zone or **Browse files**. Supported:

| File | Reads as |
|------|----------|
| **PNG card** | Character card (the embedded data, portrait included) |
| **JSON card** | Character card (V2/V3 spec or flat V1) |
| **CHARX** | Character card (card, avatar, embedded book) |
| **Worldbook JSON** | Worldbook |

The Weaver reads the file and shows you **what it carries** — the authored fields and their sizes, the portrait, any embedded lorebook, entry counts — so you can see at a glance how much material there is to work with.

For cards, it also _reads_ the card and **suggests a treatment** with a one-line reason. A card that reads as a single person gets _Rebuild as a Character_; a card that reads as a narrator running a place — a scenario card that voices many and has no single persona — gets _Build as a World_. The suggestion is just a preselection with its reasoning shown; **you always choose**, and nothing routes silently.

---

## Card Treatments

| Treatment | What happens |
|-----------|--------------|
| **Rebuild as a Character** | The card is reversed into the loom, its gaps are interviewed, and it's rewoven to studio quality. |
| **Build as a World** | Its places and people become a narrator card with a lore book behind it — the [world treatment](worlds.md). |

Either way, **the original card lands in your library first, untouched** — portrait intact, and if it carried an embedded lorebook, that book is stored standalone and bound to it. You can chat with the original immediately and compare it against the rebuild later.

Then the import session starts, and it behaves like any build:

- **Read-back** shows what the card actually establishes as committed facts — this is your "what's there / what's missing" surface. A surprising number of popular cards turn out to be mostly empty here.
- **The interview asks only the gaps.** If the card pins down the premise but has no real core tension, that's what you get asked about. Material the card already carries is never re-asked.
- **Render and finalize** work as usual. The rebuilt card wears the original's portrait and carries its embedded book, so it arrives ready to play.

!!! tip "Compare them"
    After finalizing, chat with the original and the rebuild side by side. The rebuild should be the same idea, sharper — your additions where the gaps were, a consistent voice, and fields that agree with each other. If you prefer the original in places, its text is right there to copy from; it never went anywhere.

---

## Worldbook Treatments

A worldbook can go four ways:

| Treatment | What happens | What you end up with |
|-----------|--------------|---------------------|
| **Enrich the entries** | Each entry is deepened in place, conditioned on the rest of the book. | The same book, richer. |
| **Generate a character** | The book is mined for a person, who is built at full depth. | A character card that carries the book. |
| **Build a World** | The book becomes the lore base; the interview asks only what the lore can't supply. | A narrator card with your book behind it. |
| **Store as-is** | The book is imported unchanged. | A normal worldbook, ready to attach to anything. |

**Build a World** is the standout for a book you've invested in: you already wrote the lore, so the world interview skips everything an entry already answers and asks only for what a narrator needs — the premise, the tension, the stance toward `{{user}}`, the voice. The finished world consults your imported book in play, and its own lore book still grows from the [hub](worlds.md#the-hub).

### How Enrich Runs

Enrich works through the book one entry at a time, with a progress row per entry:

- **Enriched** — the entry came out deeper: more specific, still making the original's claims, still playable.
- **Kept the original** — the rewrite didn't clear the quality bar, so the original stands untouched, with a note saying why.

Every enriched entry is checked before it's written: it must stay grounded in what the original claimed (enrichment deepens, it doesn't invent contradictions), and an entry that doesn't come out _better_ is simply kept. **Stop** at any point — everything finished so far stays, the book is valid at every moment, and you can open it in the editor or re-run enrich later.

---

## Things Worth Knowing

- **Import sessions resume like any other.** They live on the loom, autosave, and pick up where you left off.
- **The original is the fallback, always.** No treatment modifies the file you imported or the original-card copy in your library.
- **CHARX extras:** the fallback copy takes the card, avatar, and embedded book. Expression packs and galleries inside a CHARX are skipped here — use the library's import button when you want full-fidelity CHARX import instead of a rebuild.
- **A PNG with only a lorebook in it** reads as a card, because that's what it is — export the book to worldbook JSON if you want the book treatments.
