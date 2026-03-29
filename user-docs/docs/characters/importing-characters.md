# Importing Characters

The fastest way to populate your character library is by importing existing character cards. Lumiverse supports multiple import methods and formats.

---

## Supported Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| **PNG Card** | `.png` | An image file with character data embedded in metadata chunks |
| **JSON Card** | `.json` | Raw character data (CCSv1, v2, or v3 format) |
| **CHARX Bundle** | `.charx` | A ZIP archive containing the card JSON, avatar, expressions, and other assets |

All three Character Card Specification versions (v1, v2, v3) are auto-detected and converted.

---

## Import from File

1. Open the **Character Browser** panel
2. Click the **Import** button
3. Select your file(s) or drag them into the drop zone
4. The character appears in your library immediately

For PNG cards, the image itself becomes the character's avatar.

---

## Import from URL

You can import directly from popular character hosting sites:

1. Open the **Character Browser** panel
2. Click **Import from URL**
3. Paste the URL and click **Import**

### Supported Sites

- **Chub.ai** — `https://chub.ai/characters/author/name`
- **CharacterHub** — `https://characterhub.org/characters/author/name`
- **JanitorAI** — `https://janitorai.com/characters/...`
- **Direct links** — Any URL pointing to a `.png`, `.json`, or `.charx` file

The avatar is automatically downloaded when available.

---

## Bulk Import

Need to import many characters at once? Use bulk import:

1. Open the **Character Browser** panel
2. Click **Import** and select multiple files (up to 500 at a time)
3. A progress modal shows the status of each import
4. When finished, you'll see a summary of successes, skips, and failures

### Skip Duplicates

Enable **Skip Duplicates** during bulk import to avoid creating copies of characters you already have. Characters are matched by exact name.

---

## Embedded Lorebooks

Some character cards include an embedded **World Book** (lorebook) in their data. When you import such a character:

- The lorebook is automatically created as a separate World Book
- It's linked to the character so it activates in their chats
- The import summary tells you the lorebook name and entry count

You can view and edit the imported lorebook in the [World Books](../world-books/index.md) panel.

---

## CHARX Modules

CHARX bundles can include Lumiverse-specific modules:

- **Expressions** — Emotion-to-image mappings for dynamic character sprites
- **Alternate Fields** — Variant descriptions, personalities, and scenarios
- **Alternate Avatars** — Multiple avatar options

These are automatically imported and attached to the character. The import summary tells you exactly what was included.

---

## Migrating from SillyTavern

If you're coming from SillyTavern, Lumiverse includes a full interactive migration tool that imports characters, chat history, world books, and personas in one go. See the [Migrating from SillyTavern](../getting-started/installation.md#migrating-from-sillytavern) guide for the complete walkthrough.
