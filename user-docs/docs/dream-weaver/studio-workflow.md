# Studio Workflow

The Studio is a chat thread. You type slash commands in the composer, tool cards appear in the log with their results, and you decide what to keep with a click.

---

## Starting a Weave

1. Open the **Dream Weaver** panel.
2. Choose **Character** or **Scenario** with the header switcher.
3. Open or create a session — the Studio opens to its empty thread.
4. Type your source with `/dream …` (or fill the panel's **Source Material** field before opening the Studio). The Dream Summary card appears in the log.
5. Run tools (`/name`, `/appearance`, …) or hit **Run Full Suite** to generate the core set in one go.

If the log is empty, the Studio shows a short onboarding prompt: _"Describe your concept. Type /dream followed by a few sentences about your character — their personality, look, or role."_

!!! warning "Tools need source first"
    Every generation tool except `/help` and `/dream` is blocked until a Dream Summary exists. Add one with `/dream …` before running anything else.

!!! tip "Good source pays off"
    Include the premise, mood, relationship to `{{user}}`, genre, constraints, and anything you don't want. Specific source = specific results. See [Sources & Roadmap](sources-and-roadmap.md).

---

## The Composer

The chat composer sits at the bottom of the Studio. Type a message and hit Enter to send (Shift+Enter for a new line). The placeholder reads _"/dream describe the setup, or run /name. Shift+Enter for a new line."_

### Slash Command Autocomplete

Typing `/` opens a popover with matching tools (up to 6 results), grouped by category (**Soul**, **World**, **Lifecycle**). Each entry shows the command, display name, and a short description. Press **Tab** to complete the highlighted command, or **Enter** to submit it directly.

### Sending a Command With Direction

You can append instruction text after the command. The tool uses it as guidance for that run:

```text
/personality make her warmth feel practiced, not natural
```

```text
/scenario keep {{user}} as a suspicious guest arriving during a storm
```

Direction can also be added _after_ a tool runs by clicking **Adjust** on its tool card (see below).

---

## Tools

All tools below need source material to be present (added via `/dream`) except `/help` and `/dream` itself.

| Command | Category | Purpose | Mode |
|---------|----------|---------|------|
| `/dream` | Lifecycle | Add or edit the dream source for the session. | Append / edit |
| `/help` | Lifecycle | List every tool with a short description. | — |
| `/name` | Soul | Generate the character name (or scenario title). | Overwrite |
| `/appearance` | Soul | Generate appearance, setting, or visual presentation. | Overwrite |
| `/personality` | Soul | Generate behavioral patterns, habits, contradictions. | Overwrite |
| `/scenario` | Soul | Generate the current situation and relationship to `{{user}}`. | Overwrite |
| `/voice` | Soul | Generate voice guidance — baseline, rhythm, diction, quirks, hard nos. | Overwrite |
| `/first_message` | Soul | Generate the main opening message. | Overwrite |
| `/greeting` | Soul | Generate an alternate entry-point greeting. | Overwrite |
| `/add_lorebook` | World | Generate one lorebook entry (keys, comment, content). | Append |
| `/add_npc` | World | Generate one supporting NPC (name, description, optional voice notes). | Append |

**Overwrite** tools replace the previously accepted result for that field — accepting a new `/name` card swaps the name on the draft. **Append** tools add to a list — every `/add_npc` you accept stacks another NPC on the draft.

---

## Tool Cards

Each generation produces a **tool card** in the chat log. The card header shows the tool icon, display name, intent line (e.g. _"Setting the character's name"_), status badge, execution time, and token usage. While the tool is running, output fields show skeleton loaders.

Once the card reaches **Ready to Review**, the action row appears:

| Action | Result |
|--------|--------|
| **Use result** | Accept the output. Adds (or replaces) the matching field on the draft. |
| **Run again** | Re-run the same command with the same arguments. Produces a new card that supersedes the old one. |
| **Adjust** | Open the inline **nudge** box and re-run with extra guidance. The old card is marked _Replaced_. |
| **Discard** | Reject the output. The card stays in the log for reference but the draft is not updated. |

You can also **Cancel run** while a card is in progress, and expand **Run details** on any completed card to see the raw structured output.

### Adjust / Nudge

Clicking **Adjust** drops a small "What should change?" input under the card with a **Run adjusted** button. Use it to retry without retyping the original command:

```text
make her warmth feel practiced, not natural — keep the height and outfit
```

Run adjusted produces a new tool card linked to the previous one (with `supersedes_id`). The old card is greyed out and tagged **Replaced**; the new card becomes the latest in the chain.

---

## Run Full Suite

When the Studio has source material, a banner above the chat log offers **Run Full Suite**. It runs **name → appearance → personality → scenario → first message → voice** in sequence and queues all the tool cards into the log. When the run finishes, the banner shows:

> _N tools ready — review results below, then accept what you like._

You still have to accept each card individually — the suite generates the candidates but doesn't auto-apply them. If any step fails, the banner switches to an error state with a **Retry** button.

Use Run Full Suite when you want a complete first draft to react to. Skip it when you want to iterate on a single field — running `/name` then `/appearance` manually gives you tighter control.

---

## Progress Badges

A horizontal **Character Progress** (or **Scenario Progress**) bar sits above the chat. Each tracked field appears as a chip — Name, Personality, First Message, Scenario, Appearance, Voice — with a checkmark once accepted. Required fields are visually highlighted while they're still missing. The right-hand counter shows the running total (e.g. `4 / 6`).

The bar updates every time you accept a tool card.

---

## Required Fields for Finalize

You can't finalize until three fields are filled:

| Field | Character | Scenario |
|-------|-----------|----------|
| **Name / Title** | Character name | Scenario title |
| **Personality** | Character behavior | Narrator or world behavior |
| **First Message** | Opening message | Opening narration |

If any of those is missing, the Studio footer reads _"Needs … before finalizing"_ and the **Finalize** button is disabled. Appearance, scenario, voice guidance, lorebook entries, NPCs, alternate greetings, and visuals are all optional — finalize will happily ship a minimal card if that's what you want.

---

## Voice Guidance Editor

The `/voice` tool produces a structured voice profile, edited in the **Voice Guidance** editor (opened from the voice tool card or from the workspace panel). Each rule lives under one of five categories:

| Category | Use it for |
|----------|------------|
| **Baseline** | Core vocal characteristics (tone, register, pacing baseline). |
| **Rhythm** | Speech patterns, pacing variations, pauses. |
| **Diction** | Word choice, vocabulary level, formality. |
| **Quirks** | Idiosyncratic speech patterns, verbal tics, signature phrases. |
| **Hard nos** | Absolute rules to avoid (forbidden words, accents you don't want, etc.). |

Each category is a list of rules — add, remove, or reorder freely. A category badge shows how many rules it contains.

A **Structured / Compiled** toggle at the top of the editor switches between the editable rule view and the read-only compiled string that's actually fed to the model at runtime.

`/voice` populates both halves automatically. Hand-editing the rules afterwards is encouraged when the auto-generated wording doesn't match what you hear in your head.

---

## Workspace Behaviour

The workspace draft is rebuilt from your accepted tool cards on every change. If a tool card is later **discarded** or **superseded** by a newer accepted card, the draft updates accordingly. Nothing is "saved" — the chat log is the source of truth, and the draft is just the latest accepted projection of it.

Common adjustments when something feels off:

| Goal | Example nudge |
|------|---------------|
| More grounded | `less dramatic, more everyday` |
| More specific | `add concrete habits and visual details` |
| Less polished | `make the wording rougher and more natural` |
| Stronger constraint | `avoid royal, noble, or chosen-one language` |
| More scenario-focused | `treat this as a place and situation, not a single person` |

---

## Common Workflows

### Character

1. `/dream` your concept (or fill **Source Material** before opening).
2. Hit **Run Full Suite** and let it queue six cards.
3. Walk down the log: **Use result** for keepers, **Adjust** on anything close-but-wrong, **Run again** if you want a different draft of the same thing.
4. Add `/add_lorebook` / `/add_npc` if the card needs supporting world detail.
5. Open the **Visuals** tab to generate a portrait.
6. **Finalize Character** once Name, Personality, and First Message are checked off.

### Scenario

1. Flip the header switcher to **Scenario**.
2. `/dream` the premise, setting, tone, and `{{user}}`'s role.
3. `/name` for the scenario title, `/appearance` for the setting, `/personality` for narrator behavior, `/scenario` and `/first_message` for the opening situation.
4. Use `/voice` to lock in narrator voice (optional but recommended).
5. **Finalize Scenario**.

You can mix and match — the only rule is that source must exist before generation tools run.

---

## Tips

!!! tip "Nudge before re-running"
    Pick **Adjust** over **Run again** when the result is _almost_ right. A nudge that mentions what to keep is faster than rerolling from scratch.

!!! tip "Use Run Full Suite for first drafts only"
    The Suite is great for generating six candidates fast. For revisions, run tools individually — you'll get cards that respond to recent context instead of restarting from the source.

!!! tip "Append tools stack"
    `/add_npc` and `/add_lorebook` don't replace previous entries. Run them once per NPC or lore beat you want; the draft collects them all.
