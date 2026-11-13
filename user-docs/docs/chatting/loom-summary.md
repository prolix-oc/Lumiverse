---
title: Summary
---

# Summary

Summary (also called **Loom Summary**) keeps one editable overview of the story in the current chat's metadata. An LLM can update it from the previous summary and selected recent messages, or you can write it yourself. Include `{{loomSummary}}` in your preset to make the saved text available to the chat model.

**Summary needs neither embeddings nor Memory Cortex.** It is separate from [Chat Memory / LTM](memory.md), which retrieves older passages, and [Memory Cortex](memory-cortex.md), which tracks entities and relationships and consolidates scenes/arcs. Cortex's `{{arc}}` does not read the saved Loom Summary.

## Where to Configure It

Open the sidebar **Summary** panel with a chat selected. The panel contains the summary editor, summarization settings, and prompt templates. These controls are not in Settings → Embeddings or Settings → Memory Cortex.

1. Choose **Manual** or **Automatic** under **Summarization Mode**.
2. Under **API Source**, use the active LLM connection or choose a dedicated connection for summary requests.
3. Set how many messages to include. In Automatic mode, also set the interval and message lag.
4. Click **Generate** to update the summary, review the text, and save any manual corrections.
5. Add `{{loomSummary}}` to an enabled system block in your active preset, usually before Chat History.

You can save a hand-written summary without making a model request. Summary generation uses an LLM connection, not an embedding connection or the Cortex sidecar configuration.

## Modes and Message Selection

| Setting | Behavior |
|---------|----------|
| **Disabled** | Disables automatic summarization. It does not erase a saved summary or prevent `{{loomSummary}}` from reading it. |
| **Manual** | Generate when you choose to |
| **Automatic** | Update the summary after the configured number of new messages |
| **Interval** | How often automatic updates occur |
| **Context** (Automatic) | How many messages an automatic pass considers |
| **Message Lag** | Leave the newest messages out of automatic summarization, allowing recent events to settle before they enter the summary |
| **Manual Context** | How many messages to consider when generating manually, including in Automatic mode |
| **API Source** | Active connection or a dedicated LLM connection |
| **Request Timeout** | How long to allow a summary request before it times out |

A pass updates the previous summary using its selected messages. It does not reread every old message each time. Summaries can omit or misinterpret events; review the result after important changes.

## Summary Editor Controls

- **Generate** updates from selected recent messages and the existing summary.
- **Rebuild** regenerates from chat history in batches. Review the confirmation: this replaces the current summary and can make multiple model requests.
- **Refresh** reloads the saved summary from chat metadata.
- **Clear** removes this chat's summary.
- **Save** persists your manual edits.

Rebuilding a Summary is different from **Recompile Memories** in the chat input menu or **Rebuild** in Cortex settings. Those prepare recall chunks and Cortex records; they do not regenerate Loom Summary.

## Prompt Template and Summary Structure

The default summarization instructions organize the overview into these categories:

| Category | Default item limit | Purpose |
|----------|:------------------:|---------|
| Completed Objectives | 7 | Resolved arcs, milestones, concluded conflicts |
| Focused Objectives | 5 | Active story threads |
| Foreshadowing Beats | 5 | Hints, promises, warnings |
| Character Developments | 7 | Changes in beliefs, skills, or emotional state |
| Memorable Actions | 7 | Significant events and actions |
| Memorable Dialogues | 5 | Confessions, promises, threats, revelations |
| Relationships | 5 | Trust, tension, affection, rivalry |

These are instructions to the summarizing model, not guarantees that it preserves every event. The **Prompt Template** controls let you edit the system/user instructions or restore the server defaults. A custom prompt can produce a different structure.

## Put the Summary in the Prompt

Use an enabled system block such as:

```text
Story so far:
{{loomSummary}}
```

The macro reads the saved summary for this chat; it does not generate one. It returns empty text if no summary is saved. There is no automatic summary injection when the macro is absent. Check the resolved prompt in the prompt breakdown / dry-run to confirm your active preset includes it.

For a combined setup, use separate blocks containing `{{loomSummary}}` and `{{memories}}`: the first supplies a saved overview, the second retrieves earlier context. Add individual Cortex macros only if you want a custom layout; see [Cortex prompt placement](memory-cortex.md#put-cortex-in-the-prompt).

## Limit Messages in Context

In the Summary panel, enable **Limit messages in context** and set **Message Count** to restrict the raw chat history sent to the model. This operates independently of summary generation.

Limiting history does not itself summarize removed messages. Before relying on it, save a useful summary and confirm `{{loomSummary}}` is present in your active preset. Keep the summary updated as the chat progresses. The Chat Memory exclusion window is a separate setting and does not automatically match this message limit.

## Troubleshooting

| Symptom | What to check |
|---------|---------------|
| A summary is saved but the model cannot see it | Check `{{loomSummary}}` in an enabled block of the active preset and inspect the resolved prompt. |
| `{{loomSummary}}` is empty | Select the correct chat, refresh its summary, and generate or save text there. |
| Summary generation fails | Check the active/dedicated LLM connection, credentials/model, and timeout. Embedding settings will not fix a summary request. |
| Older events are missing | A normal pass uses selected recent messages plus the previous summary. Correct it manually or rebuild history. |
| Summary appears after disabling summarization | Disabled does not delete saved text. Clear the summary or remove/disable its preset block if you want it out of the prompt. |
