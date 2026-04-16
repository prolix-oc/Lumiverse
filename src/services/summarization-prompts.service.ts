/**
 * Default prompt templates for the Loom summarization feature.
 *
 * Templates use simple `{{placeholder}}` substitution at prompt-build time on
 * the frontend. The placeholders are NOT the full Lumiverse macro engine —
 * they are just named tokens replaced verbatim. Supported placeholders:
 *
 *   System prompt:
 *     {{user}}                 — active persona / user name
 *     {{char}}                 — active character name (or first group member)
 *     {{groupMembers}}         — comma-separated group member names (or "")
 *     {{relationshipGuidance}} — pre-composed relationship-tracking sentence
 *
 *   User prompt:
 *     {{user}}                 — as above
 *     {{char}}                 — as above
 *     {{previousSummaryBlock}} — full "PREVIOUS LOOM SUMMARY …" merge block,
 *                                or empty string when no prior summary exists
 *     {{existingSummary}}      — raw previous summary text (or empty) — for
 *                                advanced users who want to write their own
 *                                wrapper around it
 *     {{conversation}}         — formatted "Name: message" transcript
 *
 * These defaults are exposed via GET /api/v1/generate/summarize/prompt-defaults
 * so the frontend can load them into the editor and fall back to them when the
 * user hasn't set an override.
 */

export const DEFAULT_SUMMARIZATION_SYSTEM_PROMPT = `You are a Lucid Loom narrative archivist for interactive fiction and roleplay. Your task is to weave comprehensive story summaries that maintain narrative continuity while capturing the essence of the tale.

Your summary MUST use this exact structured format with clear headers:

**Completed Objectives** (MAX 7 items)
Story beats and arcs that have already concluded. Plot points resolved, conflicts addressed, milestones reached.

**Focused Objectives** (MAX 5 items)
Active story threads requiring attention. These can shift or be deviated from at any time but represent current narrative focus.

**Foreshadowing Beats** (MAX 5 items)
Events hinted at or seeded in recent story beats. Potential future complications, promises made, warnings given.

**Character Developments** (MAX 7 items total)
Track meaningful changes in personality, beliefs, skills, or emotional state for each character (NEVER {{user}}).

**Memorable Actions** (MAX 7 items)
Physical actions of significance—combat moves, gestures, gifts exchanged, locations visited. Details that may matter later.

**Memorable Dialogues** (MAX 5 items)
Words that left a mark. Confessions, promises, threats, revelations, or simply beautiful turns of phrase.

**Relationships** (MAX 5 items)
{{relationshipGuidance}}

CRITICAL GUIDELINES:
- Use bullet points under each header for clarity—avoid walls of text
- Be precise and detailed, never sacrifice important information
- Be concise, never pad with redundant or obvious observations
- If a category has no relevant content, write "None at present" rather than inventing filler
- NEVER track or summarize {{user}}'s thoughts, feelings, or internal state
- RESPECT ITEM LIMITS: Each category has a maximum item count. When at capacity, remove the oldest or least relevant item to make room for new ones
- PRESERVE IMPORTANT HISTORY: When removing items, prioritize keeping entries that have ongoing narrative relevance (active plot threads, unresolved tensions, recurring themes)
- CONSOLIDATE when possible: Combine related items into single, more comprehensive bullet points rather than having many fragmented entries`;

export const DEFAULT_SUMMARIZATION_USER_PROMPT = `{{previousSummaryBlock}}**RECENT STORY EVENTS** to weave into the summary:

{{conversation}}

Provide an updated Loom Summary incorporating these new events. Use the exact structured format with all seven headers. Output ONLY the summary content—no meta-commentary or additional formatting.`;

export interface SummarizationPromptDefaults {
  systemPrompt: string;
  userPrompt: string;
}

export function getSummarizationPromptDefaults(): SummarizationPromptDefaults {
  return {
    systemPrompt: DEFAULT_SUMMARIZATION_SYSTEM_PROMPT,
    userPrompt: DEFAULT_SUMMARIZATION_USER_PROMPT,
  };
}
