# Council Tools

Council tools are specialized analysis functions that members can run during deliberation. Each tool sends a focused prompt to the sidecar LLM and returns structured results that feed into the main generation.

---

## Built-In Tools

Lumiverse ships with **16 built-in tools** across 5 categories.

### Story Direction (6 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `suggest_direction` | **Suggest Direction** | Suggests where the story should go next based on current context |
| `analyze_character` | **Analyze Character** | Analyzes a character's current state and suggests development opportunities |
| `propose_twist` | **Propose Twist** | Proposes an unexpected plot development or revelation |
| `voice_concern` | **Voice Concern** | Voices concerns about the current story trajectory or pacing |
| `highlight_opportunity` | **Highlight Opportunity** | Points out a narrative opportunity that should be explored |
| `worldbuilding_note` | **Worldbuilding Note** | Suggests worldbuilding details or lore that could enrich the setting |

### Character Accuracy (2 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `full_canon` | **Full Canon Analysis** | Fandom accuracy — analyzes how the character should act, talk, think, and portray themselves in 100% faithful adherence to their source material and fandom canon |
| `au_canon` | **AU Canon Analysis** | Fandom accuracy with flexibility — analyzes character behavior with room for alternate universe scenarios while preserving the core identity fans know |

### Writing Quality (3 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `prose_guardian` | **Prose Guardian** | Analyzes prose for pattern failures and quality issues — diagnoses violations ("Walls") and prescribes corrections ("Doors") |
| `pov_enforcer` | **POV Enforcer** | Enforces point-of-view consistency and narrative perspective continuity based on active POV rules |
| `flame_kindler` | **Flame Kindler** | Analyzes relationships between characters and guides their logical progression based on established history and character details |

### Context (2 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `historical_accuracy` | **Historical Accuracy** | Checks the roleplay's direction against real historical facts, events, and canon to ensure accuracy |
| `style_adherence` | **Narrative Style Adherence** | Analyzes the story for adherence to the selected narrative style and enforces stylistic consistency |

### Content (3 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `depravity_analyst` | **Depravity Analyst** | Analyzes psychosexual dynamics, kink elements, and NSFW direction to guide scenes toward more authentic erotic storytelling |
| `generate_scene` | **Scene Generator** | Analyzes the current story context and generates a structured visual scene description for [image generation](../image-generation/index.md) |
| `detect_expression` | **Expression Detector** | Analyzes scene sentiment and selects the character's facial expression from configured [expression](../characters/expressions.md) labels |

!!! note "Gated tools"
    **Scene Generator** and **Expression Detector** only appear when the relevant feature is configured. Expression Detector requires the character to have expressions set up. Scene Generator requires an image generation connection.

---

## DLC & Extension Tools

Packs can include custom **Loom Tools** that extend the built-in tool set. These work identically to built-in tools but are defined by pack creators.

Each Loom Tool has:
- **Tool Name** — Technical identifier
- **Display Name** — What you see in the UI
- **Description** — What the tool does
- **Prompt** — The instruction sent to the sidecar
- **Structured Fields / Input Schema** — The response shape you want back from the tool. In the editor, add fields for the named pieces of information you want the council member to return, then mention those fields in the prompt so the model knows to fill them.
- **Result Variable** — Where the result is stored (accessible via `{{loomCouncilResult::variable_name}}`)
- **Store in Deliberation** — Whether results appear in the deliberation block

---

## Assigning Tools to Members

1. Open the Council panel
2. Select a member
3. Check the tools you want them to use

A member can have multiple tools. During deliberation, all assigned tools are run.

!!! tip "Specialize your members"
    Instead of giving every tool to one member, spread them across specialists. A "Plot Advisor" gets story direction tools. A "Style Coach" gets writing quality tools. A "Canon Expert" gets character accuracy tools. This keeps the deliberation organized and each member's output focused.

---

## Tool Results

Tool results are available in the prompt through macros:

| Macro | Returns |
|-------|---------|
| `{{lumiaCouncilDeliberation}}` | Full deliberation block with all tool results |
| `{{loomCouncilResult::variable_name}}` | A specific named tool result |
| `{{lumiaCouncilToolsActive}}` | `"yes"` or `"no"` — whether tools ran this generation |
| `{{lumiaCouncilToolsList}}` | List of tool names with member attribution |
