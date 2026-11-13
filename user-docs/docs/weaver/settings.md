---
title: Settings
---

# Settings

The gear in the studio home's header opens the Weaver settings. Every field here **overrides an engine default** — a blank field means "use the default," and the default is always visible as the field's placeholder, so you can see exactly what you're changing. Clear a field and save to go back to stock.

These are studio-wide settings: they apply to every build, not per session.

---

## How Much the Studio Does in One Go

| Setting | What it controls |
|---------|------------------|
| **People per proposal** | How many people one **Propose people** pass suggests on a world's [People pane](people.md). |
| **Questions before a profile is suggested** | How many [weave](people.md#weave-a-named-npc) answers the pane considers "enough for a solid profile." You can always weave earlier or keep answering past it. |
| **Extra questions an interview may ask** | The cap on **deepening** questions after a build's essentials are covered. Raise it for builds where you want a thick [depth or lore book](studio-workflow.md#6-finalize) out of one session; post-finalize **Add lore** on a world is uncapped regardless. |
| **Most people picked up from one build** | The ceiling on how many people the world harvests into the roster from your own interview material at finalize. |

---

## How the Model Runs

Two temperatures, split by the kind of work. Higher is looser; lower is more deterministic.

| Setting | What it covers |
|---------|----------------|
| **Writing temperature** | Everything the model _composes_ for you — questions, directions, the Bible, rendered fields, lore entries, profiles. |
| **Judging temperature** | Everything the model _checks_ — the quality gates, the read-back, the import reading. |

The split exists because the two jobs want different things: writing benefits from room to move, judging benefits from consistency. If rendered fields feel samey, nudge the writing temperature up; if gate verdicts feel erratic between re-checks, bring the judging temperature down. Blank for both is a sensible place to live.
