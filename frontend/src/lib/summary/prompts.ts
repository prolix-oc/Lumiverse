import type { Message } from '@/types/api'

interface SummaryPrompt {
  systemPrompt: string
  userPrompt: string
}

/**
 * Frontend fallback for the backend-hosted default prompts. The canonical source
 * of truth lives in `src/services/summarization-prompts.service.ts` and is served
 * via `GET /api/v1/generate/summarize/prompt-defaults`. These literals exist so
 * that summary generation still works if the defaults fetch fails (e.g. offline
 * start, network blip). The backend version takes precedence whenever available.
 */
export const FALLBACK_SUMMARIZATION_SYSTEM_PROMPT = `You are a Lucid Loom narrative archivist for interactive fiction and roleplay. Your task is to weave comprehensive story summaries that maintain narrative continuity while capturing the essence of the tale.

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
- CONSOLIDATE when possible: Combine related items into single, more comprehensive bullet points rather than having many fragmented entries`

export const FALLBACK_SUMMARIZATION_USER_PROMPT = `{{previousSummaryBlock}}**RECENT STORY EVENTS** to weave into the summary:

{{conversation}}

Provide an updated Loom Summary incorporating these new events. Use the exact structured format with all seven headers. Output ONLY the summary content—no meta-commentary or additional formatting.`

/** Placeholders recognised in the system prompt template. */
export const SYSTEM_PROMPT_PLACEHOLDERS = [
  { token: '{{user}}', description: 'Active persona / user name' },
  { token: '{{char}}', description: 'Active character name (or first group member)' },
  { token: '{{groupMembers}}', description: 'Comma-separated group member names' },
  { token: '{{relationshipGuidance}}', description: 'Pre-composed relationship-tracking sentence' },
] as const

/** Placeholders recognised in the user prompt template. */
export const USER_PROMPT_PLACEHOLDERS = [
  { token: '{{user}}', description: 'Active persona / user name' },
  { token: '{{char}}', description: 'Active character name (or first group member)' },
  { token: '{{previousSummaryBlock}}', description: 'Full "PREVIOUS LOOM SUMMARY" merge block (empty when none)' },
  { token: '{{existingSummary}}', description: 'Raw previous summary text (empty when none)' },
  { token: '{{conversation}}', description: 'Formatted "Name: message" transcript' },
] as const

interface BuildSummarizationPromptOpts {
  recentMessages: Message[]
  existingSummary: string
  userName: string
  characterName: string
  isGroup: boolean
  groupMembers?: string[]
  /** Optional override for the system prompt template. Falls back to systemTemplate. */
  systemPromptOverride?: string | null
  /** Optional override for the user prompt template. Falls back to userTemplate. */
  userPromptOverride?: string | null
  /** Default templates, typically fetched from the backend. */
  systemTemplate?: string
  userTemplate?: string
}

/**
 * Build the Loom summarization prompt from recent messages by substituting
 * the computed placeholder values into the provided (or default) templates.
 */
export function buildSummarizationPrompt(opts: BuildSummarizationPromptOpts): SummaryPrompt | null {
  const {
    recentMessages,
    existingSummary,
    userName,
    characterName,
    isGroup,
    groupMembers = [],
    systemPromptOverride,
    userPromptOverride,
    systemTemplate = FALLBACK_SUMMARIZATION_SYSTEM_PROMPT,
    userTemplate = FALLBACK_SUMMARIZATION_USER_PROMPT,
  } = opts

  if (recentMessages.length === 0) return null

  // Compose the dynamic placeholder values
  const memberList = groupMembers.length > 0 ? groupMembers.join(', ') : 'group members'
  const relationshipGuidance = isGroup
    ? `Track evolving dynamics between characters (${memberList}) and between characters and ${userName}. Trust, tension, affection, rivalry. (NEVER track ${userName}'s internal state—only how characters perceive or relate to them.)`
    : `Track evolving dynamics between ${characterName} and ${userName}, as well as any NPCs. Trust, tension, affection, rivalry. (NEVER track ${userName}'s internal state—only how characters perceive or relate to them.)`

  // Build conversation text
  let conversationText = ''
  for (const msg of recentMessages) {
    const role = msg.is_user ? (msg.name || 'User') : (msg.name || 'Character')
    let content = msg.content || ''
    // Strip any existing loom_sum blocks
    content = content.replace(/<loom_sum>[\s\S]*?<\/loom_sum>/gi, '').trim()
    if (content) {
      conversationText += `${role}: ${content}\n\n`
    }
  }

  const previousSummaryBlock = existingSummary
    ? `**PREVIOUS LOOM SUMMARY** (use this as your foundation—do NOT discard important information):
${existingSummary}

---

**MERGE INSTRUCTIONS:**
- Start with ALL existing entries from the previous summary
- Add new developments from the recent events below
- When a category exceeds its item limit, consolidate related items or remove the least narratively relevant
- NEVER silently drop items that still have ongoing relevance (active conflicts, unresolved threads, important relationships)
- If an item from the previous summary is still relevant but needs updating, modify it rather than removing it

---

`
    : ''

  const substitutions: Record<string, string> = {
    '{{user}}': userName,
    '{{char}}': characterName,
    '{{groupMembers}}': groupMembers.join(', '),
    '{{relationshipGuidance}}': relationshipGuidance,
    '{{previousSummaryBlock}}': previousSummaryBlock,
    '{{existingSummary}}': existingSummary,
    '{{conversation}}': conversationText.trimEnd(),
  }

  const systemSource = pickNonEmpty(systemPromptOverride, systemTemplate)
  const userSource = pickNonEmpty(userPromptOverride, userTemplate)

  return {
    systemPrompt: applySubstitutions(systemSource, substitutions),
    userPrompt: applySubstitutions(userSource, substitutions),
  }
}

function pickNonEmpty(override: string | null | undefined, fallback: string): string {
  if (typeof override === 'string' && override.trim().length > 0) return override
  return fallback
}

function applySubstitutions(template: string, substitutions: Record<string, string>): string {
  let out = template
  for (const [token, value] of Object.entries(substitutions)) {
    // split/join avoids regex escape edge cases and handles every literal occurrence
    out = out.split(token).join(value)
  }
  return out
}
