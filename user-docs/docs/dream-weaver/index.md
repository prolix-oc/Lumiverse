# Dream Weaver

Dream Weaver turns an idea into a finished character or scenario card. You describe what you want, run a handful of tools, review the results, and accept the ones that fit. When the required fields are filled in, **Finalize** writes a real card to your library and creates its launch chat.

Dream Weaver is best when you have a clear idea but writing the fields by hand would take too long, or when you want a polished first draft you can edit afterwards.

---

## What's New: Dream Weaver 2.0

The Studio is now **chat-based**. Instead of a card pane on the side, you have a chat thread where each tool you run produces an embedded **tool card** that you accept, retry, adjust, or discard inline.

Key changes from earlier versions:

- **Chat-style composer** with slash-command autocomplete.
- **Tool cards** appear in the thread with `Use result` / `Run again` / `Adjust` / `Discard` actions.
- **Adjust** opens an inline nudge box so you can retry a tool with extra guidance.
- **Run Full Suite** generates name, appearance, personality, scenario, first message, and voice in one go.
- **Progress badges** at the top show which fields are still missing before you can finalize.
- **Editable Dream source** — open the Dream Summary card, click the pencil, and rewrite your source at any time.
- **Voice Guidance editor** for structured baseline / rhythm / diction / quirks / hard nos rules.
- **Visuals tab** with portrait stage, ComfyUI workflow editor, and a **Suggest Tags** helper.

The slash command vocabulary is mostly unchanged — `/dream`, `/name`, `/appearance`, `/personality`, `/scenario`, `/voice`, `/first_message`, `/greeting`, `/add_lorebook`, `/add_npc`, `/help` — but they now produce tool cards rather than full-screen drafts.

---

## When to Use Dream Weaver

Use Dream Weaver when you want to:

1. Turn an idea into a character or scenario card
2. Create a card that matches a role, setup, or scenario you can't find elsewhere
3. Get help writing the parts of a card that are hard to phrase manually
4. Iterate on individual fields without rewriting the whole card
5. Add supporting lore (NPCs, lorebook entries) after the main idea is clear

Dream Weaver works best when you know what you want but need help turning it into a finished card.

---

## When Not to Use It

Use the regular **Character Browser** when you already know the exact edits you want.

| Situation | Better Tool |
|-----------|-------------|
| You only need to fix a typo | Character editor |
| You already know the exact field text | Character editor |
| You want to manually tag or organize a card | Character editor |
| You are importing a finished character card | Character import |
| You do not want generated suggestions | Character editor |

You can always edit Dream Weaver output later in the regular character editor. If you reopen the same Dream Weaver session, **Update Character** or **Update Scenario** updates the linked card instead of creating a duplicate.

---

## Studio Layout

The Studio is a centred modal with two tabs:

| Tab | Purpose |
|-----|---------|
| **Studio** | The chat thread where you run tools, review tool cards, and edit voice guidance. Progress badges and the Suite Runner banner sit above the log. |
| **Visuals** | Portrait stage and image-gen controls — generate the card's portrait once the text fields take shape. |

A header strip carries the session name, a **Character / Scenario** switcher (disabled once the session is finalized), and a **Draft / Linked** status pill. The footer shows the same status with a **Close** button and a **Finalize** (or **Update**) button. If any required field is missing, the footer tells you which ones.

---

## Chat Thread Artifacts

Anything that happens in a session shows up as an entry in the chat log:

| Artifact | What it is |
|----------|------------|
| **Dream Summary** | A summary of the active source. Shows the dream text plus optional tone and dislikes chips. Click the pencil to edit. |
| **User Command Bubble** | The slash command you ran, shown as a small grey bubble. |
| **Tool Card** | The result of a tool run. Includes a header (tool name, intent), execution time, token usage, output fields, and the action buttons. Expand **Run details** for the raw output. |
| **System Note** | Inline note from the Studio itself — `/help` output, status changes, or errors. |
| **Nudge Inline** | Appears when you click **Adjust** on a tool card. Lets you type what should change before retrying. |

---

## Character vs. Scenario

Dream Weaver doesn't infer the card type from your source text. Pick **Character** or **Scenario** with the switcher in the header.

Use **Character** when you want one primary character.

Use **Scenario** when you want a narrator, world, location, setup, or situation card.

| Command | Character Mode | Scenario Mode |
|---------|----------------|---------------|
| `/name` | Character name | Scenario title |
| `/appearance` | Physical appearance | Setting and sensory presentation |
| `/personality` | Character behavior | Narrator, world behavior, or interaction rules |
| `/scenario` | Starting situation around the character | Premise, tension, and current scene |
| `/voice` | Character speech style | Narrator or world voice |
| `/first_message` | Character opening message | Opening narration or scene prompt |

The switcher controls which framing the tools write to. `/dream` only adds direction for Dream Weaver to use — it does not pick the card type for you.

---

## Saved Weaves

The Dream Weaver panel keeps every session in **Previous Weaves**. Filter by **All**, **Drafts**, or **Finalized**, or use search to find an older session. Finalized sessions live in the same list — they're tagged with a different status pill — and can be reopened to keep iterating on the linked card.

---

## Quick Links

| Guide | What You'll Learn |
|-------|-------------------|
| [Studio Workflow](studio-workflow.md) | Use the chat composer, slash commands, tool cards, Suite Runner, and the Voice Guidance editor. |
| [Sources & Roadmap](sources-and-roadmap.md) | Add and edit dream source, what counts as useful source, and what import sources are planned. |
| [Visuals & Finalizing](visuals-and-finalizing.md) | Generate portraits, manage ComfyUI workflows, suggest tags, finalize, and update the linked card. |
