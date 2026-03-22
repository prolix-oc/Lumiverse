import type { Message } from '@/types/api'

interface SummaryPrompt {
  systemPrompt: string
  userPrompt: string
}

/**
 * Build the Loom summarization prompt from recent messages.
 * Lumiverse Loom summarization prompt builder.
 */
export function buildSummarizationPrompt(
  recentMessages: Message[],
  existingSummary: string,
  userName: string,
  characterName: string,
  isGroup: boolean,
  groupMembers: string[] = [],
): SummaryPrompt | null {
  if (recentMessages.length === 0) return null

  let relationshipDesc: string
  if (isGroup) {
    const memberList = groupMembers.length > 0 ? groupMembers.join(', ') : 'group members'
    relationshipDesc = `Track evolving dynamics between characters (${memberList}) and between characters and ${userName}. Trust, tension, affection, rivalry. (NEVER track ${userName}'s internal state—only how characters perceive or relate to them.)`
  } else {
    relationshipDesc = `Track evolving dynamics between ${characterName} and ${userName}, as well as any NPCs. Trust, tension, affection, rivalry. (NEVER track ${userName}'s internal state—only how characters perceive or relate to them.)`
  }

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

  const systemPrompt = `You are a Lucid Loom narrative archivist for interactive fiction and roleplay. Your task is to weave comprehensive story summaries that maintain narrative continuity while capturing the essence of the tale.

Your summary MUST use this exact structured format with clear headers:

**Completed Objectives** (MAX 7 items)
Story beats and arcs that have already concluded. Plot points resolved, conflicts addressed, milestones reached.

**Focused Objectives** (MAX 5 items)
Active story threads requiring attention. These can shift or be deviated from at any time but represent current narrative focus.

**Foreshadowing Beats** (MAX 5 items)
Events hinted at or seeded in recent story beats. Potential future complications, promises made, warnings given.

**Character Developments** (MAX 7 items total)
Track meaningful changes in personality, beliefs, skills, or emotional state for each character (NEVER ${userName}).

**Memorable Actions** (MAX 7 items)
Physical actions of significance—combat moves, gestures, gifts exchanged, locations visited. Details that may matter later.

**Memorable Dialogues** (MAX 5 items)
Words that left a mark. Confessions, promises, threats, revelations, or simply beautiful turns of phrase.

**Relationships** (MAX 5 items)
${relationshipDesc}

CRITICAL GUIDELINES:
- Use bullet points under each header for clarity—avoid walls of text
- Be precise and detailed, never sacrifice important information
- Be concise, never pad with redundant or obvious observations
- If a category has no relevant content, write "None at present" rather than inventing filler
- NEVER track or summarize ${userName}'s thoughts, feelings, or internal state
- RESPECT ITEM LIMITS: Each category has a maximum item count. When at capacity, remove the oldest or least relevant item to make room for new ones
- PRESERVE IMPORTANT HISTORY: When removing items, prioritize keeping entries that have ongoing narrative relevance (active plot threads, unresolved tensions, recurring themes)
- CONSOLIDATE when possible: Combine related items into single, more comprehensive bullet points rather than having many fragmented entries`

  const mergeBlock = existingSummary
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

  const userPrompt = `${mergeBlock}**RECENT STORY EVENTS** to weave into the summary:

${conversationText}

Provide an updated Loom Summary incorporating these new events. Use the exact structured format with all seven headers. Output ONLY the summary content—no meta-commentary or additional formatting.`

  return { systemPrompt, userPrompt }
}
