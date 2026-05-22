# Sources & Roadmap

Dream Weaver needs direction before it can generate useful cards. The text you give it is called **source**, and it lives on a special card in the chat log called the **Dream Summary**. Every tool reads the active source before generating, so the source is what holds your whole weave together.

---

## Available Now

Dream Weaver currently supports text source added through the panel or with `/dream`.

| Source | How to Add It | Notes |
|--------|---------------|-------|
| Initial source | Fill **Source Material** in the Dream Weaver panel before opening the Studio | Inserted into the chat as a Dream Summary card when the Studio opens. |
| In-Studio source | Open the Studio, then type `/dream your source text` | Useful when you opened the Studio empty. |
| Additional source | Run `/dream your extra material` again | Updates the existing Dream Summary card with the new content — does not stack a second source card. |

Example:

```text
/dream Alice is my bully. She runs the student council and hides a soft streak she resents.
```

!!! warning "Source before tools"
    Every generation tool — `/name`, `/appearance`, `/personality`, `/scenario`, `/voice`, `/first_message`, `/greeting`, `/add_lorebook`, `/add_npc` — is blocked until a Dream Summary exists. Only `/help` and `/dream` are available beforehand.

---

## Editing the Dream Summary Inline

The Dream Summary card has a pencil icon. Click it to edit the source text directly in the card — no need to retype `/dream` from scratch. Editing the summary also re-runs any tone / dislikes parsing the card does so the chips at the bottom stay in sync.

Editing source mid-weave does **not** retroactively change tool cards you've already accepted. Use **Run again** or **Adjust** on those tool cards if you want them to re-read the new source.

The Dream Summary also surfaces a couple of optional metadata chips when present:

| Chip | What it means |
|------|---------------|
| **Tone** | A short tone label (e.g. _melancholic_, _wry_, _menacing_) that tools fold into prompts. |
| **Dislikes** | Things you specifically don't want in the result. Tools treat these as soft constraints. |

Tone and dislikes are derived from your source text — there's no separate field to fill in.

---

## What Counts as Useful Source

Good source doesn't need to be polished. It just needs enough detail for Dream Weaver to understand the card you want.

Useful source can include:

1. Character idea or scenario premise
2. Tone and emotional texture
3. Relationship to `{{user}}`
4. Setting rules or world constraints
5. Character contradictions
6. Things to avoid
7. Existing card or world book details you want preserved

Weak source is usually too broad:

```text
/dream make a mysterious girl
```

Stronger source gives Dream Weaver something specific to preserve:

```text
/dream A transfer student who always knows the answer before the teacher asks. She is not psychic. She is reliving the same school week and is starting to resent everyone for not remembering.
```

The more concrete the source, the less rerolling you'll do downstream.

---

## Iterating on Source

Source isn't carved in stone. A typical iteration pattern:

1. Type a first source with `/dream`.
2. Run `/name`, `/appearance`, `/personality` — read the results.
3. If the results miss the mark, edit the Dream Summary to tighten the brief.
4. Hit **Run again** or **Adjust** on the affected tool cards so they re-read the updated source.

You can repeat this as many times as you like before finalizing. The chat log keeps every card you've generated, so you can compare a "before tightened source" card against an "after" one without losing either.

---

## Planned Source Workflows

More source types are planned but not available yet.

| Future Workflow | Intended Use |
|-----------------|--------------|
| Import a character as source | Use an existing non-Dream Weaver character as reference material. |
| Import a world book as source | Generate a character from lore, factions, locations, or NPC entries. |
| Attach or import a world book into a finalized card | Add existing lore to the final card workflow. |
| Generate a scenario from a world book | Turn a setting or lore collection into a narrator/scenario card. |

When these import flows arrive, imported material will appear as the Dream Summary's content — and the rest of the chat-based workflow (composer, tool cards, suite, finalize) will stay exactly the same.

---

## Tips

!!! tip "Edit the summary before reaching for Run again"
    Tightening source upstream often produces a better result than nudging the tool downstream. Both work — but a one-sentence edit to the Dream Summary fixes every tool you run after, not just the one card.

!!! tip "List dislikes explicitly"
    Saying _"avoid royal, noble, or chosen-one language"_ in the source is more effective than discovering it later via Adjust. Dream Weaver folds dislikes into prompts as soft constraints from the start.
