---
title: Characters
---

# Characters

Characters are the AI personas you interact with in Lumiverse. Each character has a name, avatar, personality description, and other fields that tell the AI how to behave.

---

## What Makes Up a Character?

Every character has these core fields:

| Field | Purpose |
|-------|---------|
| **Name** | The character's display name |
| **Avatar** | A profile image |
| **Description** | Physical appearance, background, and traits |
| **Personality** | Personality traits and disposition |
| **Scenario** | The setting or situation for the conversation |
| **First Message** | The opening message when a new chat starts |
| **Example Messages** | Sample dialogue showing how the character speaks |
| **System Prompt** | Instructions to the AI about how to play this character |
| **Post-History Instructions** | Instructions injected after the chat history |
| **Creator Notes** | Notes from the character's creator (not sent to the AI) |
| **Tags** | Organizational labels for filtering |

Not every field needs to be filled in — only **Name** is required. Use as much or as little as fits your needs.

---

## Quick Links

- [Importing Characters](importing-characters.md) — Bring in character cards from files or URLs
- [Creating Characters](creating-characters.md) — Build a character from scratch
- [Expressions](expressions.md) — Add visual expressions that change with the conversation mood
- [Alternate Fields & Avatars](alternate-fields.md) — Create variants of descriptions, personalities, and avatars

---

## Character Cards & Compatibility

Lumiverse uses the **Character Card Specification** (CCSv3), the same format used by SillyTavern, Chub.ai, and other platforms. This means:

- Characters exported from other apps work in Lumiverse
- Characters created in Lumiverse can be exported and shared
- PNG character cards (images with embedded data) are fully supported
- CHARX bundles (ZIP archives) are supported, including Lumiverse-specific modules

---

## Managing Characters

From the **Character Browser** panel, you can:

- **Search** — Find characters by name, creator, or tags; choose **All fields** to search card text too
- **Filter** — Filter by tags
- **Sort** — By name, creation date, recent use, or random shuffle
- **Favorite** — Mark characters as favorites for quick access
- **Duplicate** — Create a copy of any character
- **Delete** — Remove characters you no longer need
- **Export** — Save characters as JSON, PNG, or CHARX files

Switch between **grid**, **list**, and **single** view modes depending on how you like to browse.

### Searching Card Text

In the Character Browser or homepage library, change **Search in** from **Names, creators & tags** to **All fields**. This also searches greetings (including alternates), descriptions, personalities, scenarios, example messages, creator notes, system prompts, post-history instructions, and alternate field labels and content. Text near the end of long cards is searchable too.

Each word in an all-fields search must contain at least **3 characters**. Multiple words must all occur somewhere on the card; they can match different fields. Matching uses substrings, so `school` also finds `schoolhouse`. Use the default search mode for shorter names or tags.

The first server restart after upgrading builds the card-text index. It uses additional database space and can extend that startup; later edits and imports update the index automatically.
