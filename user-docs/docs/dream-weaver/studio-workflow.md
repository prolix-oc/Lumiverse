# Studio Workflow

The Dream Weaver Studio is where you turn an idea into a card. Add direction, run commands, and decide which generated cards become part of the result.

---

## Starting a Weave

1. Open the **Dream Weaver** panel
2. Choose **Character** or **Scenario**
3. Optionally add direction in **Source Material**
4. Optionally choose persona, connection, model, refinement, or advanced generation settings
5. Open the Studio

If you enter source before opening the Studio, Dream Weaver adds it automatically. If you open a blank Studio, add direction with `/dream` before running generation commands.

!!! warning "Source is required for generation"
    The source field is optional before opening the Studio, but generation commands still need source. Use `/dream your source text` before running `/name`, `/appearance`, `/personality`, `/scenario`, `/voice`, `/first_message`, `/greeting`, `/add_lorebook`, or `/add_npc`.

!!! tip "Good source"
    Include the premise, mood, relationship to `{{user}}`, genre, constraints, and anything you do not want.

!!! note "Character or scenario"
    Dream Weaver does not detect this from your source text. Use **Character** for one primary character. Use **Scenario** for a narrator, world, location, or setup card.

---

## Commands

Type a slash command in the Studio composer. Add instructions after the command when you want to steer the result.

| Command | Use It For | Needs Source |
|---------|------------|--------------|
| `/help` | Show available commands | No |
| `/dream` | Add direction for Dream Weaver to use | No |
| `/name` | Generate or replace the name/title | Yes |
| `/appearance` | Generate appearance, setting, or visual presentation | Yes |
| `/personality` | Generate behavior, rules, habits, or contradictions | Yes |
| `/scenario` | Generate the starting situation | Yes |
| `/voice` | Generate voice guidance | Yes |
| `/first_message` | Generate the main opening message | Yes |
| `/greeting` | Generate an alternate greeting | Yes |
| `/add_lorebook` | Add one lorebook entry | Yes |
| `/add_npc` | Add one supporting NPC | Yes |

Examples:

```text
/dream A quiet rural inn is built over a sealed shrine. The owner knows more than she admits.
```

```text
/personality make her warmth feel practiced, not natural
```

```text
/scenario keep {{user}} as a suspicious guest arriving during a storm
```

---

## Cards

Most generation commands create a card. Review the card before you use it.

| Action | Result |
|--------|--------|
| **Use result** | Adds the card to the workspace |
| **Discard** | Leaves the card out |
| **Run again** | Runs the same command again |
| **Adjust** | Reruns with extra instruction |
| **Cancel run** | Stops a running card |

The card header shows status, token usage, and runtime. Open **Run details** when you need the raw tool output.

For fields like name, appearance, personality, scenario, voice, and first message, using a newer card replaces the older accepted card for that field. Lorebook entries and NPCs are added instead of replacing each other.

---

## Reading the Workspace

The workspace is the current result. It is built from the cards you have accepted. If something feels wrong, discard the card that caused the problem or run the command again with clearer instructions.

Common adjustments:

| Goal | Example |
|------|---------|
| More grounded | `less dramatic, more everyday` |
| More specific | `add concrete habits and visual details` |
| Less polished | `make the wording rougher and more natural` |
| Stronger constraint | `avoid royal, noble, or chosen-one language` |
| More scenario-focused | `treat this as a place and situation, not a single person` |

---

## Character Workflow

For a character, a common workflow is:

1. Add source with the panel field or `/dream`
2. Generate `/name`, `/appearance`, and `/personality`
3. Generate `/scenario` once the character has a clear shape
4. Generate `/voice` and `/first_message`
5. Add `/add_lorebook` or `/add_npc` only if the card needs supporting world detail
6. Use the **Visuals** tab if you want generated visual assets
7. Finalize when the required fields are filled

You can do these in a different order. The main rule is that source must exist before generation commands run.

---

## Scenario Workflow

For a scenario:

1. Set the switcher to **Scenario**
2. Use `/dream` to describe the premise, setting, tone, and role of `{{user}}`
3. Use `/name` for the scenario title
4. Use `/appearance` for the setting and sensory presentation
5. Use `/personality` for narrator or world behavior
6. Use `/scenario` and `/first_message` to establish the opening situation

Scenario mode saves through the same card system as normal characters. The difference is how Dream Weaver writes the fields.

---

## Previous Weaves

The panel keeps saved sessions under **Previous Weaves**.

Use:

1. **All** to see every session
2. **Drafts** to find unfinished sessions
3. **Finalized** to find sessions already linked to a generated card
4. **Search** to filter by source, type, or tone

Finalized sessions can be reopened. If you accept new cards and update, Dream Weaver updates the linked card instead of creating a new one.
