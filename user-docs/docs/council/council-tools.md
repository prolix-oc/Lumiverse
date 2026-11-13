---
title: Council Tools
---

# Council Tools

Council tools are specialized analysis functions that members can run during deliberation. Each tool sends a focused prompt to the sidecar LLM and returns structured results that feed into the main generation.

---

## Built-In Tools

Lumiverse ships with **17 built-in tools** across 5 categories.

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

### Context (3 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `historical_accuracy` | **Historical Accuracy** | Checks the roleplay's direction against real historical facts, events, and canon to ensure accuracy |
| `style_adherence` | **Narrative Style Adherence** | Analyzes the story for adherence to the selected narrative style and enforces stylistic consistency |
| `web_search` | **Web Search** | Runs a real-world web search via your configured SearXNG instance and returns a condensed context block from the top pages. Requires [Web Search](../settings/web-search.md) to be enabled. |

### Content (3 tools)

| Tool | Display Name | What It Does |
|------|-------------|-------------|
| `depravity_analyst` | **Depravity Analyst** | Analyzes psychosexual dynamics, kink elements, and NSFW direction to guide scenes toward more authentic erotic storytelling |
| `generate_scene` | **Scene Generator** | Analyzes the current story context and generates a structured visual scene description for [image generation](../image-generation/index.md) |
| `detect_expression` | **Expression Detector** | Analyzes scene sentiment and selects the character's facial expression from configured [expression](../characters/expressions.md) labels |

!!! note "Gated tools"
    **Scene Generator**, **Expression Detector**, and **Web Search** only appear when the relevant feature is configured. Expression Detector requires the character to have expressions set up. Scene Generator requires an image generation connection. Web Search requires [Web Search](../settings/web-search.md) to be enabled with an API URL.

---

## DLC & Extension Tools

Packs can include custom **Loom Tools** that extend the built-in tool set. These work identically to built-in tools but are defined by pack creators.

To create one, use **+ Create tool** in **Council → Setup**, either in Tools Configuration or beside a member's tool assignments. The existing tool editor opens directly. Use **Open Workshop** for broader pack and asset editing.

Each Loom Tool has:
- **Tool Name** — Technical identifier
- **Display Name** — What you see in the UI
- **Description** — What the tool does
- **Prompt** — The instruction sent to the sidecar
- **Structured Fields / Input Schema** — The response shape you want back from the tool. In the editor, add fields for the named pieces of information you want the council member to return, then mention those fields in the prompt so the model knows to fill them.
- **Result Variable** — Where the result is stored (accessible via `{{loomCouncilResult::variable_name}}`)
- **Store in Deliberation** — Whether results appear in the deliberation block

---

## MCP Tools

Connect a server in **Settings → MCP Servers** to make its tools available to the main model when **Enable Function Calling** is enabled in the active preset. A successful **Test Connection** only checks the server; use **Connect** to keep it connected. **Auto-connect on startup** reconnects it when Lumiverse starts.

To include the callable tool names and descriptions in the prompt, put `{{mcpTools}}` in a preset block. The block's role, position, and depth control where the list appears. The list is empty when no MCP tools are available, function calling is disabled, or you are generating an impersonation.

```text
{{if::{{mcpToolsActive}}}}
Use these tools when they help answer the user's request:
{{mcpTools}}
{{/if}}
```

The native function definitions are sent automatically with the model request. You can also assign MCP tools to Council members for Council execution.

---

## Assigning Tools to Members

1. Open **Council → Setup**
2. Select a member
3. Check the tools you want them to use

A member can have multiple tools. During deliberation, all assigned tools are run.

!!! tip "Specialize your members"
    Instead of giving every tool to one member, spread them across specialists. A "Plot Advisor" gets story direction tools. A "Style Coach" gets writing quality tools. A "Canon Expert" gets character accuracy tools. This keeps the deliberation organized and each member's output focused.

---

## Historical Deliberations

Each assigned member/tool pair can retain a small number of prior successful deliberations for the same chat. This lets a council member build on threads it previously planted, such as long-term plot plans, relationship beats, unresolved warnings, or recurring worldbuilding ideas.

To enable it:

1. Open **Council → Setup**
2. Expand a council member
3. Assign one or more tools
4. Under the assigned tool list, set **Historical deliberations retained** above `0`

The number is per member and per tool:

| Value | Behavior |
|-------|----------|
| `0` | Do not retain history for this member/tool assignment |
| `1` | Include only the last successful deliberation from this member/tool |
| `2-10` | Include up to that many prior successful deliberations |

Historical deliberations are chat-scoped. They do not carry across different chats, and they are matched to the exact council member plus tool assignment.

When history is enabled, Lumiverse sends it as a clearly labeled **historical baseline only** block. The prompt explicitly tells the model that prior deliberations are not a template, not binding instructions, and do not override current chat history, active world info, or the latest user message.

!!! note "Successful tool outputs only"
    Failed tool runs are not stored. If a tool is removed from a member or its retention is set back to `0`, old retained entries for that assignment are pruned the next time council history is updated.

---

## Tool Results

Open **Council → Feedback** to inspect the latest results, grouped by council member. The middle tab shows a green dot while Council is enabled, a spinner during execution, and a count when tool results are available. Without results, it shows whether Council is waiting for feedback. Use **Setup** to change members or tool assignments; use **OOC** to configure commentary alongside the story.

Tool results are available in the prompt through macros:

| Macro | Returns |
|-------|---------|
| `{{lumiaCouncilDeliberation}}` | Full deliberation block with all tool results |
| `{{loomCouncilResult::variable_name}}` | A specific named tool result |
| `{{lumiaCouncilToolsActive}}` | `"yes"` or `"no"` — whether tools ran this generation |
| `{{lumiaCouncilToolsList}}` | List of tool names with member attribution |
