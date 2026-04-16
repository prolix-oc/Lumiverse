# Managing Packs

Packs are managed through the **Content Workshop** panel.

---

## Viewing Installed Packs

Open the **Content Workshop** panel to see all installed packs. Each pack shows:

- Pack name and author
- Version number
- Whether it's a custom (user-created) pack or downloaded
- Number of Lumia items, Loom items, and Tools included

---

## Creating a Custom Pack

1. Open the **Content Workshop** panel
2. Click **New Pack**
3. Fill in the pack details:
    - **Name** — Pack name
    - **Author** — Your name
    - **Version** — Version number
4. Add items:
    - **Add Lumia** — Create a new AI persona
    - **Add Loom** — Create a narrative content block
    - **Add Tool** — Define a custom council tool
5. Save

### Creating a Lumia

| Field | Description |
|-------|-------------|
| **Name** | The persona's name |
| **Avatar** | A profile image URL |
| **Definition** | Core description of this persona |
| **Personality** | Personality traits |
| **Behavior** | How this persona interacts and gives advice |
| **Gender Identity** | Unspecified, feminine, or masculine (affects pronoun macros) |

### Creating a Loom Item

| Field | Description |
|-------|-------------|
| **Name** | Item name |
| **Content** | The text content (supports macros) |
| **Category** | Narrative style, loom utility, or retrofit |

### Creating a Loom Tool

| Field | Description |
|-------|-------------|
| **Tool Name** | Technical identifier (used in code) |
| **Display Name** | What users see |
| **Description** | What the tool does |
| **Prompt** | The instruction sent to the sidecar LLM |
| **Result Variable** | Variable name to store the result |
| **Store in Deliberation** | Whether to include in the deliberation block |

---

## Importing & Exporting

### Export

1. Select a pack in the Content Workshop
2. Click **Export**
3. The pack is saved as a JSON file with all items included

### Import

1. Click **Import Pack** in the Content Workshop
2. Select a pack JSON file
3. The pack and all its items are created

---

## Using Pack Content

### Selecting Lumia Items

Lumia items from packs are available as:

- **Council members** — Add them in the Council panel
- **Selected definitions** — Choose via settings for the `{{lumiaDef}}` macro
- **Random Lumia** — The `{{randomLumia}}` macro picks from all available items

### Selecting Loom Items

Loom items are selected via settings and used through macros:

- **Selected Styles** → `{{loomStyle}}`
- **Selected Utils** → `{{loomUtils}}`
- **Selected Retrofits** → `{{loomRetrofits}}`

### Using Loom Tools

Loom tools automatically appear in the council tools list and can be assigned to council members just like built-in tools.

---

## Pack Ordering

Items within a pack have a **sort order** that determines their display sequence. You can reorder items by dragging them in the editor.
