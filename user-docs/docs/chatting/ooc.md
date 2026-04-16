# Out-of-Character (OOC) Comments

OOC comments are special asides the AI can generate during roleplay — character-level thoughts, meta-commentary, or narrative observations that exist outside the story itself. Think of them as margin notes from the character (or council) to the reader.

---

## What Are OOC Comments?

When enabled, the AI can produce tagged blocks like `<lumia_ooc>I love where this scene is going</lumia_ooc>` inside its responses. Lumiverse extracts these blocks and renders them in a separate visual style of your choosing, keeping them distinct from the narrative text.

In council mode, individual council members can each contribute their own OOC comments, attributed by name.

---

## Enabling OOC

1. Open the **OOC Panel** (or find it in the Prompt Panel settings)
2. Toggle **Enable OOC comments** on
3. Select a **display style**
4. Optionally set an **OOC interval**

---

## Display Styles

Lumiverse offers five visual styles for OOC comments:

| Style | Description |
|-------|-------------|
| **Social Card** | A styled card with the character's avatar, name, and a "weaving through the Loom" tagline. Centered layout, polished feel. |
| **Margin Note** | A subtle side annotation with the character's initial/avatar. Alternates left and right positioning. Good for quiet, unobtrusive commentary. |
| **Whisper Bubble** | A speech bubble headed with "[Name] whispers..." — intimate and soft-spoken. |
| **Raw Text** | Plain inline text with minimal styling. For those who want OOC to blend in without decoration. |
| **IRC Chat Room** | A collapsible retro IRC-style panel labeled `#LumiaCouncil`. Shows timestamps, `<usernames>`, alternating row backgrounds, and @mention highlighting. Optionally converts handles to **l33tspeak**. |

---

## OOC Interval

The interval controls how often OOC comments appear:

| Setting | Behavior |
|---------|----------|
| **Empty (default)** | Automatic — the AI decides when OOC comments are appropriate based on the narrative |
| **A number (1-50)** | Forced frequency — an OOC block appears every N messages |

Lower numbers mean more frequent commentary. An interval of `3` means OOC roughly every third message.

---

## OOC Macros

Your preset controls *how* the AI produces OOC via these macros:

| Macro | Purpose |
|-------|---------|
| `{{lumiaOOC}}` | Main OOC prompt — adapts for normal, council, and IRC modes |
| `{{lumiaOOCErotic}}` | Mirror & Synapse erotic OOC variant |
| `{{lumiaOOCEroticBleed}}` | Narrative Rupture — mid-scene OOC bleed |
| `{{lumiaOOCTrigger}}` | Countdown or activation message based on interval |

These are typically included in Loom preset blocks. The trigger macro handles the interval logic — it tells the AI whether it's time for an OOC comment or how many messages remain until the next one.

---

## Tips

!!! tip "IRC style for council"
    IRC mode works especially well with council — each council member's OOC appears as a separate line in the chat room, creating a lively behind-the-scenes discussion.

!!! tip "Start with automatic"
    Leave the interval empty at first. The AI will insert OOC when it feels natural. If you want more (or less), set a specific number.
