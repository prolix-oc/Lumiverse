# Import & Export

World Books can be shared between Lumiverse installations and imported from other platforms.

---

## Exporting

1. Open the World Book panel
2. Select the world book you want to export
3. Click **Export**
4. Choose a format:

| Format | Description |
|--------|-------------|
| **Lumiverse** | Full-fidelity format preserving all Lumiverse-specific settings |
| **Character Book** | Standard format compatible with character card specs |
| **SillyTavern** | Compatible with SillyTavern's world info format |

---

## Importing

### From File

1. Open the World Book panel
2. Click **Import**
3. Select a world book JSON file
4. The world book and all its entries are created

### From Character Cards

When you import a character card that contains an embedded `character_book`, the lorebook is automatically extracted and created as a World Book linked to that character.

### From SillyTavern

The migration tool (`bun run migrate:st`) can import your SillyTavern world books in bulk, preserving entry settings and keywords.

---

## Attaching World Books

After importing, attach your world book to where it should be active:

### To a Character

1. Open the character editor
2. In the extensions or settings, link the world book
3. The world book activates in all chats with that character

### To a Persona

1. Open the persona editor
2. Set the **Attached World Book** field
3. The world book activates whenever that persona is active

### As a Global World Book

1. Go to **Settings**
2. Add the world book to the **Global World Books** list
3. The world book activates in every chat, always

---

## Sharing Tips

!!! tip "Export as Lumiverse format for full fidelity"
    The Lumiverse export format preserves all advanced settings (sticky, cooldown, delay, groups, vectorization). Other formats may lose some of these features.

!!! tip "Embed in character exports"
    When you export a character as PNG or CHARX, attached world books are embedded automatically. This is the easiest way to share a character with their lore.

!!! tip "Clean up before sharing"
    Remove personal or campaign-specific entries before exporting a world book for public use. Keep entries generic enough to be useful in different contexts.
