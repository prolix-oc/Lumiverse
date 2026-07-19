---
title: Worlds
---

# Worlds

A **World** is a place you roleplay in. You chat with the world itself: a **narrator** that sets scenes, runs the place, and voices the people in it, while `{{user}}` plays their own part inside it. Where a character build produces one person, a world build produces a stage with a cast.

Under the hood, a finished world is a small family of ordinary Lumiverse pieces, all bound together:

| Piece | What it carries |
|-------|-----------------|
| **The narrator card** | A deliberately thin card: the premise, the rules of the place, how it treats `{{user}}`, and the narration voice. This is what you chat with. |
| **The lore book** | The deep detail — places, history, factions, customs — as triggered entries that surface when their subject comes up, instead of crowding the card. |
| **The NPC book** | The people the narrator can voice, one profile per person. Created the first time you flesh someone out (see [People](people.md)). |
| **The rules book** | Always-on entries that keep the narrator narrating — consult the lore, don't invent canon, give each person their own voice — plus the constant re-anchor. Works under any preset. |

The thin-card-plus-books shape is the point: the card stays lean and predictable, and the depth scales as far as you want to take it — a handful of lore entries for a small place, dozens for a sprawling one.

---

## Building a World

**New → World** runs the same six stages as a character build ([Studio Workflow](studio-workflow.md)), with world-shaped questions and fields.

**The dream.** Describe the place the way you'd pitch it. The strongest world dreams carry a charged, unresolved core — the thing that makes the place worth playing in rather than just visiting:

> _"Saltmere is a fishing town that pays a yearly tithe to something under the bay. Nobody alive has seen it; the tithe is just how things are done, like the tides. This year the count came back short, and the town clerk — who keeps the ledger — has started locking her office at noon. {{user}} arrives as the new harbormaster, owed answers nobody wants to give."_

**The interview** asks for the essentials a narrator can't run the place without: what this place _is_ and why it's charged, the unresolved tension at its core, the past that produced it, the physical reality of the place, and how the world reads and treats `{{user}}`. From there it deepens into open-ended lore — the specifics of locations, factions, customs, history — and those deepening answers become the **lore book**.

**The Bible** shows the world in three plain sections — **What it is**, **How it works**, **How it plays** — with the same editing, origin tags, and quality gate as a character build. The world's gate adds world-specific checks: does `{{user}}` have a real place here, do the rules of the place actually bite, and (if the world has agency) is it earned by the material.

**Render** writes the narrator's fields: the description (the thin world bundle), the narration voice (how it describes scenes and voices people), the scenario, the opening narration, and **one greeting per distinct way into the world** — at finalize these split into the card's alternate greetings, so a world with three hooks gives you three different front doors into play.

**Finalize** publishes the narrator card with the lore book bound (on by default) and the rules book created automatically. Then the session opens into the **hub**.

---

## World Agency

Most worlds are hosts: they set scenes and follow your lead. Some push back.

Once the interview's essentials are covered, the Weaver asks once: _"Does this world push back?"_

- **Cozy** (preselected) — the world hosts your scenes and follows your lead.
- **Agency** — the world pursues an **agenda** of its own and holds **hard lines** that won't bend, enforced on the card.

If your dream already shows a world with teeth (Saltmere's tithe qualifies), the read-back picks agency up on its own and the interview asks about the agenda and the holds like any other essential — the agenda being what the world quietly works toward regardless of the player, and the holds being the lines that never break under pressure:

> **Agenda:** the tithe will be paid in full before the spring tide, one way or another.
> **Holds:** no one who has read the full ledger leaves Saltmere; the thing under the bay is never described, only evidenced.

This is **not a difficulty slider**. An agency world doesn't fight you for control of the story — it has its own weather. Scenes can strain a hold; they never break it.

You can change the decision any time from the hub: the **World agency** band shows Off (_"This world is cozy. It follows your lead."_) with **Turn on**, or On with the agenda and holds editable in place. Changes are written into the card's rules book immediately, so they hold in any chat.

---

## The Hub

A world isn't finished at finalize — that's when it starts. Opening a finalized world from the home's **In the library** shelf lands on its dashboard, and the **World** pane is its hub: the place you grow it over time.

### Lore

The lore band lists the lore book's entries with an **Open in editor** button — the lore book is a normal worldbook, so the full editor is always available for hand work.

**Add lore** continues the deepening interview right here, post-finalize and uncapped: the Weaver asks pointed questions about the world (grounded in everything it already knows — your dream, the Bible, the existing lore), you answer in your own words with the same **Show me directions** / **Extend my answer** tools, and each answer is composed into one new triggered entry in the lore book. **Done** is the escape, whenever you want.

> _"The ledger only records what was given, never to whom. Where do the tithe goods actually go on collection night, and who in Saltmere is allowed to watch?"_

The card itself never changes during add-lore — growth is append-only, new entries land in the book, and anything you've hand-edited in the book is never touched.

!!! tip "How lore reaches play"
    Lore entries are triggered worldbook entries: they surface in chat when their subject comes up, by keyword and (if you have embeddings configured) by meaning. The narrator's rules book tells it to treat surfaced lore as canon and to never invent canon that contradicts it — so the deeper your lore book, the more consistently the place holds together.

### People

The **People** rail item opens the world's roster and its spun-off characters — covered in full in [People](people.md). The short version: the world proposes people from its own lore, anyone you named during the build is already there, and each person can grow from a name, to a couple of background lines, to a full voiced profile, to their own standalone character card that knows this world.

### Agency

The **World agency** band, described above — toggle it, edit the agenda and holds, see exactly what's enforced.

---

## Playing a World

Chat with the narrator card like any character. What you should see in play:

- **The narrator narrates.** It sets scenes, describes, and voices the people of the world each in their own register — it doesn't collapse into being a single character, and it doesn't puppet `{{user}}`.
- **Lore fires on relevance.** Mention the ledger and the ledger's entry surfaces; the narrator treats it as canon.
- **People sound like themselves.** Anyone with a profile in the NPC book is voiced from that profile, not from a generic blur.
- **An agency world moves.** Its agenda advances quietly in the background, and its holds refuse direct pressure.

Because the governance rides in the card's own bound rules book, all of this works under any preset — though a preset that actively mandates first-person single-character play is fighting the narrator's contract, and it's worth using a more neutral preset for world chats.

!!! note "In-universe characters"
    A person who outgrows the narrator's voicing can be **promoted** to their own card for one-on-one chats — they carry the world's lore book with them, so they stay consistent with the place. See [People → Promote](people.md#promote-their-own-card).
