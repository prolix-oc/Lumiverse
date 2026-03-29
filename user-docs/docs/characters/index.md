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

- **Search** — Find characters by name or creator
- **Filter** — Filter by tags
- **Sort** — By name, creation date, recent use, or random shuffle
- **Favorite** — Mark characters as favorites for quick access
- **Duplicate** — Create a copy of any character
- **Delete** — Remove characters you no longer need
- **Export** — Save characters as JSON, PNG, or CHARX files

Switch between **grid**, **list**, and **single** view modes depending on how you like to browse.
