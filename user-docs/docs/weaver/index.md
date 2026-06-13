# Weaver

The Weaver is Lumiverse's authoring studio. It turns an idea into finished, playable content — a **character** you chat with, a **world** you roleplay in, or a rebuild of something you **import** — by interviewing you about your idea, gathering everything into a single coherent source called the **Bible**, checking that source against a quality bar, and only then writing the output. Whatever you build lands in your regular library as a normal card; you author in the Weaver and play from the library.

The Weaver is best when you have an idea in your head but writing every field by hand would be slow, or when one-shot "make me a character" tools keep handing you the same generic result.

---

## Why It Works This Way

Most character generators do the same thing: you type a prompt, the model writes the whole card in one shot. The problem is that a short prompt is a near-empty space, and a model fills empty space with its **most average** guess — the same handful of names, the same tropes, the same beats, no matter how many times you reroll. Turning up the temperature or writing a cleverer prompt doesn't fix it, because the result is being pulled toward the middle of everything the model has ever seen.

The Weaver is built on the opposite idea: **the hard part isn't writing — models write fluently — it's getting your specific idea out of your head and refusing to let it get averaged away.** So the Weaver spends its effort up front, eliciting the particular, original details that make the idea _yours_, locking them into one source of truth, and writing every output from that source. Generation is the easy last step.

Three principles fall out of that:

- **Elicit before you generate.** The interview asks plain, pointed questions about _your_ idea — not a generic questionnaire — and you answer in your own words. Your words are kept, tracked, and weighed above anything the model suggests.
- **One source, then render from it.** Everything you decide is gathered into a single gated Bible. Each output field is written from that Bible, so the description, the voice, and the first message all agree with each other.
- **A quality bar with teeth.** The Bible is checked for genericness, coherence, and tension _before_ any field is written, so you're not polishing output that was thin to begin with.

---

## The Studio Home

Open the Weaver from the side drawer. The studio opens to a home with two shelves:

| Shelf | What's on it |
|-------|--------------|
| **On the loom** | Builds in progress, by last touched. Open one to pick up exactly where you left off. |
| **In the library** | Finished builds. Open one to reach its dashboard — the card, its portrait and expressions, and (for worlds) the hub. |

**New** opens the type chooser:

| Type | What you get |
|------|--------------|
| **Character** | A single person you chat with, grown from your idea. |
| **World** | A place you roleplay in. It sets scenes and voices its people. |
| **Import** | Bring in an existing card or worldbook and build from it. |

The gear in the home header opens the [Weaver settings](settings.md) — how much the studio does in one go, and how hot the model runs.

Everything autosaves as you go. Sessions are fully resumable: close the studio mid-interview and the loom holds your place.

---

## The Stages

Every build — character, world, or import — moves through the same stages. The rail along the top shows where you are, and you can step back to an earlier stage at any time.

| Stage | What happens |
|-------|--------------|
| **Dream** | You describe your idea in your own words. |
| **Read-back** | The Weaver tells you what it understood and what it still needs, so you can correct it before it commits. |
| **Interview** | Plain, pointed questions pull the specifics out of your idea. You answer in your own words. |
| **Bible** | Everything is gathered into one coherent source, checked against a quality bar. |
| **Render** | Each card field is written from the Bible, and you accept, edit, or re-render each one. |
| **Finalize** | A real card is written to your library, with its governance and any backing books bound to it. |

After finalizing, the build's **dashboard** takes over: generate a [portrait and expressions](visual-studio.md), and for worlds, grow the place from its [hub](worlds.md) — more lore, [people](people.md), and spin-off characters over time.

---

## How a Finished Build Ships

A Weaver card is deliberately **lean**. The card carries only the load-bearing fields; everything else rides in small worldbooks bound to it:

- A **rules book** — always-on entries that keep the character (or narrator) playing to spec in any chat, plus a constant "re-anchor" that keeps them on-spine in long sessions. This is why a Weaver card needs **no special preset**: its governance travels with the card itself.
- For worlds, a **lore book** (deep detail that surfaces when relevant) and an **NPC book** (the people the narrator can voice). For characters, an optional **depth book** of the same kind.

Everything is a normal Lumiverse card and normal worldbooks — export them, edit them in the regular editors, attach them elsewhere. Nothing is locked to the studio.

---

## When to Use the Weaver

Use the Weaver when you want to:

1. Turn an idea into a complete character card or a playable world
2. Get a result that's specific and yours, not a reroll of the same tropes
3. Upgrade an existing card or worldbook to studio quality
4. Shape something through questions and choices instead of a blank page

Use the regular **Character Browser** when you already know the exact edits you want:

| Situation | Better Tool |
|-----------|-------------|
| You only need to fix a typo | Character editor |
| You already know the exact field text | Character editor |
| You're importing a finished card to use as-is | Character import |
| You don't want generated suggestions | Character editor |

You can always edit Weaver output later in the regular character and worldbook editors.

---

## Quick Links

| Guide | What You'll Learn |
|-------|-------------------|
| [Studio Workflow](studio-workflow.md) | Every stage in order — what each step is for, what to do, and what to expect. |
| [Worlds](worlds.md) | Build a narrator-run place: the world interview, the hub, lore, and world agency. |
| [People](people.md) | Populate a world: extras, named NPCs, and promoting someone to their own card. |
| [Imports](imports.md) | Rebuild an existing card to studio quality, or mine a worldbook for a character or world. |
| [Visual Studio](visual-studio.md) | Generate a portrait and a full expression set, and what each image provider supports. |
| [Settings](settings.md) | Tune how much the studio does in one go and how the model runs. |
