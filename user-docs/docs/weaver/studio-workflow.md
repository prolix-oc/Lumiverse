---
title: Studio Workflow
---

# Studio Workflow

Every Weaver build walks through six stages, in order: **Dream → Read-back → Interview → Bible → Render → Finalize**. The rail at the top shows where you are; you can always step back to an earlier stage, and your work autosaves as you go.

This page covers each stage in detail: what it's for, what to do, and what to expect. The examples follow a character build; a [world build](worlds.md) runs the same stages with world-shaped questions and fields, and an [import](imports.md) enters the same pipeline with the Bible pre-filled from your file.

---

## 1. Dream

**What it's for:** this is your idea in your own words — the raw material everything else is built from. The Weaver keeps your dream text verbatim and consults it at every later stage, so nothing you write here gets lost in translation.

**What to do:** write a few sentences about your idea and click **Read my dream**. You don't need to be tidy or complete; you need to be _specific_.

!!! tip "Specific in, specific out"
    The single biggest lever on your result is how particular your dream is. Include the premise, the mood, the character's relationship to `{{user}}`, the genre, any constraints, and anything you _don't_ want. A pointed detail — a contradiction, a fear, a specific habit — pulls the whole result toward something that's actually yours.

    Compare:

    > _"A mysterious radio host."_

    > _"Marisol runs the overnight call-in show at a tiny mountain station. Some of her callers haven't been born yet, and she's stopped being surprised by it — what scares her is that lately they've started asking for her by a name she hasn't told anyone. She's warm on air and guarded off it. She thinks {{user}} is the first listener who's noticed the pattern."_

    The first dream gives the Weaver nothing to hold onto. The second one gives it a premise, a tension, a voice, and a reason `{{user}}` matters — and every question it asks from here will be about _this_ host, not "a mysterious radio host" in general.

**Generation setup:** the rail beside the dream box carries the session's **persona**, **connection**, and **model**. These persist on the session, so a build keeps using the setup you gave it even if you change your defaults later.

**What to expect:** the Weaver reads your dream and moves you to Read-back.

---

## 2. Read-back

**What it's for:** before the Weaver commits to anything, it shows you what it understood and what it still needs. This is your chance to correct a misread early, while it's cheap.

**What you'll see:**

- **From your dream** — the concrete facts the Weaver locked in, each one traceable to what you wrote. Click any fact to fix or sharpen it, remove ones that are wrong, or **Add another** the read-back missed.
- **What I'll handle next** — everything still open, sorted into three groups: what the Weaver will **ask you** about in the interview, what's **part yours, part its** (it asks the core, writes the rest), and what it will **write itself** from everything above. Some slots only appear when your dream implies them, tagged **detected**. If you'd rather decide something it planned to write, click it to claim it for the interview.

!!! note "Why it asks about some things and writes others"
    The Weaver interviews you about the parts that make the result _specific_ — the core tension, what they want, how they treat `{{user}}`. It writes the rest — the name, physical details, the voice — itself, drawn from that core. You beat generic output by getting the core right, not by being quizzed on every field.

**What to do:** correct anything wrong, then continue to the Interview. **Re-read** runs the read-back again from scratch if you've reworked the dream (this replaces your edits).

---

## 3. Interview

**What it's for:** this is where your specific idea actually gets pulled out. The Weaver reads your dream and asks about what's still open — one question at a time, in plain words, each with a one-line note on _why_ it's asking. Questions are generated for your subject, not from a script: a question that could be asked about any character doesn't make the cut.

**What to do:** answer in your own words, in the text box, then **Use my answer**. That's the whole loop. For the radio-host dream above, expect questions like:

> _"Marisol's callers ask for her by a name she hasn't told anyone. Where does that name come from, and what would it cost her if someone said it to her face?"_
> — Why: this pins the secret your dream circles without naming.

Your answer doesn't have to fit the question's shape. Answer sideways, answer two things at once, contradict the premise of the question — the Weaver listens for everything an answer establishes, so one good answer often covers several open slots at once.

**If you're stuck**, two tools sit under the answer box:

| Tool | What it does |
|------|--------------|
| **Show me directions** | Three genuinely different directions the answer could go. Pick one and it drops into the box for you to make yours — edit it, gut it, keep a phrase. You can also **steer** the directions ("more grounded", "stranger") and ask for a new set. |
| **Extend my answer** | Takes the draft you've already written and pushes it further, keeping your words. Pick an extension to replace your draft, then keep editing. |

!!! note "Your words carry more weight"
    The Weaver tracks whose words every fact is made of — typed by you, picked from a suggestion, or extended from your draft — and weighs verbatim-you material highest when it builds the Bible. The tools are there for when you're stuck, not as the main path: the more of the answer that's yours, the more the result is yours.

**Deepening:** once the essentials are covered, the rail switches to _"Essentials covered · deepening"_ and the same loop keeps going — now into material that's worth knowing but doesn't belong on the card itself (backstory beats, relationships, specifics of the world around them). These answers are carried beyond the card: at finalize they can become a triggered **depth book** (or, for worlds, the **lore book**) that surfaces in chat when relevant instead of bloating the card. There's a cap on deepening questions, adjustable in [settings](settings.md).

**What to do:** answer as long as it's earning its keep, then **Finish interview**. You never have to answer everything — finishing early just means the Weaver writes more itself, from what it has. **Re-run interview** undoes your answers and starts the questions over if a build has drifted.

!!! note "Worlds: the agency question"
    In a world build, once the essentials are covered the interview asks one extra question — _"Does this world push back?"_ — with **Cozy** (it hosts your scenes and follows your lead) preselected against **Agency** (it pursues an agenda and holds hard lines). Pick either; you can change it any time from the world's hub. See [Worlds](worlds.md#world-agency).

---

## 4. Bible

**What it's for:** the Weaver gathers everything — your facts, your interview answers, and the parts it writes to fit them — into one coherent source, called the Bible. This is the single source of truth every output field is later written from, which is what makes the finished fields agree with each other.

Before you go further, the Bible is checked against a quality bar that looks for the things that make results fall flat: vagueness, pieces that don't hang together, a missing core tension, the obvious version of the idea, drift away from your dream. Catching that here is the point — it's cheaper to fix the source than to polish thin output later.

**What you'll see:**

- A plain-language **brief** — the subject in a paragraph, the headline you react to.
- The underlying entries, in plain sections (for a character: **Who they are**, **How they act**, **How they come across**), each tagged with where it came from: **Yours** (your words), **Weaver wrote** (written to fit your material), or **My guess, check it** (inferred — read these).
- A **Depth** band listing your deepening answers — the material that will back the card from a triggered book rather than sit on it.
- The **quality gate** result — _"All checks pass"_, or a count of checks that need work, each with a concrete note on what's thin and how to fix it.

**What to do:** read the brief first. If it's not the thing you imagined, fix the entries — click any entry to edit it — then **Re-check** to score your edits, or **Rebuild** to throw the synthesis away and regenerate it from your facts (your facts and answers survive a rebuild; only the woven result is replaced).

You can continue to Render even if the gate flagged something — you hold the final say — but expect more generic fields if the source was thin. The flag tells you exactly which checks failed and why.

---

## 5. Render

**What it's for:** now the card fields get written, each one **from the frozen Bible** — never from each other. That's what keeps the description, the voice, and the first message consistent. Each field is then checked on its own: does it stay faithful to the Bible, and does it drift back toward the generic?

**The fields** (for a character — a [world](worlds.md) renders narrator-shaped fields instead):

| Field | What it is |
|-------|------------|
| **Name** | Carried straight from the Bible — not model-generated. |
| **Description** | The load-bearing character sheet, in tagged sections. |
| **Personality** | A voice-and-speech spec — how the character actually sounds. |
| **Scenario** | The opening situation and what's at stake with `{{user}}`. |
| **First message** | The character's opening, in their own voice. |
| **Example messages** | Sample exchanges that show range. |

**What you can do to any field:**

| Action | Result |
|--------|--------|
| **Accept** | Sign the field off. Every field must be accepted before finalize. |
| **Edit** | Hand-edit the text yourself; your edit is kept and tagged, and is never overwritten without your say-so. |
| **Re-render** | Write the field again from the Bible. |
| **Nudge** | Re-render with a short steer — _"leaner"_, _"more guarded"_, _"less lyrical"_. |

A field that fails its check comes back **flagged with a reason** and a suggestion — re-render it, or strengthen the Bible entries it draws from. The Weaver surfaces problems and waits; it never silently retries behind your back.

!!! note "If you change the Bible later"
    Fields are written from a specific version of the Bible. If you go back and change the Bible, the affected fields are marked **stale** so you know to re-render them. Hand-edited fields always ask before being replaced.

**What to do:** **Render all fields**, then walk down the list — accept the keepers, nudge the near-misses. Once every field is accepted, **Continue to finalize**.

---

## 6. Finalize

**What it's for:** this writes a real card to your library, with everything it needs to play well bound to it.

A Weaver card ships deliberately lean. The fields you accepted go on the card; everything else rides in small worldbooks bound to it:

- **The rules book** — created automatically. Always-on entries that keep the character playing to spec in any chat (the craft and anti-pattern rules), plus a constant **re-anchor** that keeps them on-spine even deep into a long session. Because governance travels on the card's own bound book, **the card works under any preset** — there's nothing to install and nothing to select.
- **The depth book** — optional, off by default, offered when you gave deepening answers. _"Bind a depth book to the card"_ turns your deepening answers into a triggered worldbook: composed, titled entries that surface in chat when their subject comes up, instead of sitting on the card. (World builds bind a **lore book** here instead, on by default.)

**What to do:** review the summary bands, set the book toggles, and click **Finalize**. Then:

- **Start chat** opens a fresh chat with the new card.
- **Continue to Visual Studio** jumps to the [portrait and expressions](visual-studio.md).

The card is now in your library like any other — chat with it, export it, edit it in the regular editor. The session moves to the home's **In the library** shelf, and opening it later lands on the build's dashboard.

!!! note "The books are yours too"
    The rules, depth, and lore books are ordinary worldbooks. You'll see them bound to the card (named after it — _"Marisol rules book"_, _"Marisol depth book"_), and you can open them in the regular worldbook editor, hand-edit entries, or detach them like any other book.

---

## A Typical Run

1. **Dream** your concept — be specific about the premise, the tension, and what makes this idea _this_ idea.
2. **Read-back:** fix anything the Weaver misread; claim anything you'd rather decide yourself.
3. **Interview:** answer in your own words; reach for **Show me directions** only when stuck; keep going into deepening while it's earning its keep, then **Finish**.
4. **Bible:** read the brief, tighten anything off, pass the gate.
5. **Render:** render all, accept the keepers, nudge the rest.
6. **Finalize** with the book toggles you want, then **Start chat**.
7. Optionally, open the [Visual Studio](visual-studio.md) for a portrait and expressions — and for a world, start growing the [hub](worlds.md#the-hub).
