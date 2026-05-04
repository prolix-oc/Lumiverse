# Sources & Roadmap

Dream Weaver needs direction before it can generate useful cards. In the Studio, that direction is called **source**. Source can be a character idea, scenario premise, scene, pasted reference, world detail, or anything else you want Dream Weaver to build from.

---

## Available Now

Dream Weaver currently supports text source added through the panel or with `/dream`.

| Source | How to Add It | Notes |
|--------|---------------|-------|
| Initial source | Add text in **Source Material** before opening the Studio | Added when the Studio opens |
| Blank Studio source | Open a blank Studio, then use `/dream your source text` | Useful when you want to add source inside the Studio |
| Additional source | Use `/dream your extra material` at any time | Adds another accepted source card without running generation |

Use `/dream` for extra direction, missing constraints, pasted references, or new premise details.

Example:

```text
/dream Alice is my bully.
```

!!! warning "Source before tools"
    Dream Weaver blocks generation tools until source exists. `/help` and `/dream` are available first. After source is added, the rest of the commands can run.

---

## Planned Source Workflows

More source types are planned, but not available yet.

| Future Workflow | Intended Use |
|-----------------|--------------|
| Import a character as source | Use an existing non-Dream Weaver character as reference material |
| Import a world book as source | Generate a character from lore, factions, locations, or NPC entries |
| Attach or import a world book into a finalized card | Add existing lore to the final card workflow |
| Generate a scenario from a world book | Turn a setting or lore collection into a narrator/scenario card |

When these import flows are added, imported material should appear in the Studio as source, just like text added with `/dream`. After that, the command, card, accept, retry, and finalize workflow can stay the same.

---

## What Counts as Useful Source

Good source does not need to be polished. It just needs enough detail for Dream Weaver to understand the card you want.

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
