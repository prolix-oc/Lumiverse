import type { SpeechDetectionRules } from '@/types/store'

export type SegmentType = 'asterisked' | 'quoted' | 'undecorated'
export type SegmentAction = 'speech' | 'narration' | 'skip'

/**
 * Tags whose inner text is prose that SHOULD be spoken. Any tag not in this
 * set is treated as meta/scaffolding (reasoning, loom state, tool calls,
 * status cards, tracker blocks, custom structured output — anything the
 * author's prompt-craft can produce) and is dropped along with its contents.
 *
 * The list is intentionally limited to standard HTML elements that carry
 * narrative prose. Anything like `<tracker>`, `<stats>`, `<status>`,
 * `<state>`, `<thinking>`, `<loom_sum>`, etc. falls through the allowlist
 * and gets stripped wholesale.
 */
const PROSE_TAGS = new Set<string>([
  // Block containers that typically hold prose
  'p', 'div', 'span', 'section', 'article', 'header', 'footer', 'main',
  'aside', 'nav', 'address', 'blockquote', 'q', 'cite',
  'figure', 'figcaption', 'hgroup',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'menu',
  // Line-level separators (no inner content anyway)
  'br', 'hr', 'wbr',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Inline formatting — content kept, markers stripped
  'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins',
  'mark', 'small', 'big', 'sub', 'sup', 'abbr', 'acronym',
  'dfn', 'kbd', 'samp', 'var', 'time', 'font', 'tt',
  'bdi', 'bdo', 'data', 'ruby', 'rb', 'rp', 'rt', 'rtc',
  // Links — label is spoken, href is dropped with the opening tag
  'a',
  // Tables — cells often hold prose
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
  // Misc prose carriers
  'label', 'legend', 'fieldset',
])

/** Paired tag — `<TAG...>…</TAG>`. Non-greedy so the innermost pair matches first. */
const PAIRED_TAG_RE = /<([a-z][\w-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1\s*>/gi
/** Self-closing: requires a `/` before the closing `>`. */
const SELF_CLOSING_RE = /<([a-z][\w-]*)(?:\s[^>]*?)?\s*\/\s*>/gi
/** Any opening tag (used to find the first unclosed non-prose tag). */
const OPENING_TAG_RE = /<([a-z][\w-]*)(?:\s[^>]*)?>/gi
/** Closing marker `</TAG>`. */
const CLOSING_TAG_RE = /<\/([a-z][\w-]*)\s*>/gi
/** Any remaining tag marker (allowlisted tags after their contents are kept). */
const ANY_TAG_MARKER_RE = /<\/?[a-z][\w-]*(?:\s[^>]*)?\s*\/?>/gi

const FENCED_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const MD_IMAGE_RE = /!\[[^\]]*]\([^)]*\)/g
const MD_LINK_RE = /\[([^\]]+)]\([^)]+\)/g

const HTML_ENTITY_MAP: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&lsquo;': "'",
  '&rsquo;': "'",
}
const HTML_ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot|apos|#39|ldquo|rdquo|lsquo|rsquo);/g

const MAX_SWEEP_ITERATIONS = 10

function isProse(tag: string): boolean {
  return PROSE_TAGS.has(tag.toLowerCase())
}

/**
 * Iteratively drop paired non-prose tags along with their contents. Iteration
 * handles the rare case where sibling tag removal exposes a newly-completable
 * outer pair. Bounded by MAX_SWEEP_ITERATIONS as a safety valve.
 */
function stripNonProsePairedTags(text: string): string {
  let out = text
  let prev: string
  let i = 0
  do {
    prev = out
    out = out.replace(PAIRED_TAG_RE, (match, tag) => (isProse(tag as string) ? match : ' '))
    i++
  } while (out !== prev && i < MAX_SWEEP_ITERATIONS)
  return out
}

/** Drop self-closing non-prose tags (`<tracker/>`, `<loom_state />`, etc.). */
function stripNonProseSelfClosingTags(text: string): string {
  return text.replace(SELF_CLOSING_RE, (match, tag) => (isProse(tag as string) ? match : ' '))
}

/**
 * If an unpaired (never-closed) non-prose tag remains — typical of streams
 * that were cut off mid-meta-block — drop from that tag to end-of-input.
 * Walks left-to-right so prose that precedes the meta-block is preserved.
 */
function stripTrailingUnclosedNonProseTag(text: string): string {
  OPENING_TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OPENING_TAG_RE.exec(text)) !== null) {
    if (!isProse(match[1])) {
      return text.slice(0, match.index)
    }
  }
  return text
}

/** Drop stray non-prose closing markers (e.g. `</tracker>` with no opener). */
function stripStrayNonProseClosings(text: string): string {
  return text.replace(CLOSING_TAG_RE, (match, tag) => (isProse(tag as string) ? match : ' '))
}

/**
 * Remove anything that reads poorly (or nonsensically) when spoken.
 *
 * Strategy: maintain an allowlist of prose HTML tags. Paired tags whose name
 * is NOT on the allowlist (including every custom `<tracker>`, `<stats>`,
 * `<status>`, reasoning tag, loom tag, `<details>` card, etc.) are removed
 * together with their contents. Self-closing and stray-closing variants are
 * dropped. Unclosed non-prose tags (interrupted streams) are dropped from
 * the tag to end-of-input. Finally, allowlisted tag markers are stripped so
 * their inner text is preserved.
 */
export function sanitizeForTts(text: string): string {
  let out = text

  // 1. Strip code first so `<` inside code can't be misread as tag syntax.
  out = out.replace(FENCED_CODE_RE, ' ')
  out = out.replace(INLINE_CODE_RE, ' ')

  // 2. Tag sweeps. Paired → self-closing → unclosed trailing → stray closings.
  out = stripNonProsePairedTags(out)
  out = stripNonProseSelfClosingTags(out)
  out = stripTrailingUnclosedNonProseTag(out)
  out = stripStrayNonProseClosings(out)

  // 3. Markdown: images dropped entirely, links reduced to their label text.
  out = out.replace(MD_IMAGE_RE, ' ')
  out = out.replace(MD_LINK_RE, '$1')

  // 4. Strip any remaining tag markers (only prose tags at this point); the
  //    inner text survives because only the marker is removed.
  out = out.replace(ANY_TAG_MARKER_RE, ' ')

  // 5. Decode a handful of common HTML entities so they're pronounced, not spelled.
  out = out.replace(HTML_ENTITY_RE, (m) => HTML_ENTITY_MAP[m] ?? m)

  // 6. Collapse whitespace (including newlines) into single spaces.
  out = out.replace(/\s+/g, ' ').trim()

  return out
}

export interface TextSegment {
  text: string
  type: SegmentType
  action: SegmentAction
}

function resolveAction(type: SegmentType, rules: SpeechDetectionRules): SegmentAction {
  switch (type) {
    case 'asterisked':
      return rules.asterisked === 'skip' ? 'skip' : 'narration'
    case 'quoted':
      return rules.quoted
    case 'undecorated':
      return rules.undecorated
  }
}

/**
 * Parse raw message text into classified segments.
 *
 * - *text between asterisks* → asterisked
 * - "text between quotes" → quoted
 * - everything else → undecorated
 *
 * Each segment is assigned an action based on the user's speech detection rules.
 */
export function parseSegments(text: string, rules: SpeechDetectionRules): TextSegment[] {
  const pattern = /\*([^*]+)\*|"([^"]+)"|([^*"]+)/g
  const raw: TextSegment[] = []

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    if (match[1] !== undefined) {
      const trimmed = match[1].trim()
      if (trimmed) {
        const type: SegmentType = 'asterisked'
        raw.push({ text: trimmed, type, action: resolveAction(type, rules) })
      }
    } else if (match[2] !== undefined) {
      const trimmed = match[2].trim()
      if (trimmed) {
        const type: SegmentType = 'quoted'
        raw.push({ text: trimmed, type, action: resolveAction(type, rules) })
      }
    } else if (match[3] !== undefined) {
      const trimmed = match[3].trim()
      if (trimmed) {
        const type: SegmentType = 'undecorated'
        raw.push({ text: trimmed, type, action: resolveAction(type, rules) })
      }
    }
  }

  // Merge adjacent segments with the same action
  const merged: TextSegment[] = []
  for (const seg of raw) {
    const last = merged[merged.length - 1]
    if (last && last.action === seg.action && last.type === seg.type) {
      last.text += ' ' + seg.text
    } else {
      merged.push({ ...seg })
    }
  }

  return merged
}

/**
 * Filter and concatenate segments that should be spoken aloud.
 * Returns the text string to send to TTS, or null if nothing to speak.
 *
 * The input is first sanitized (HTML tags, reasoning/loom meta, code fences,
 * etc. removed) so the segment parser only sees prose.
 */
export function getSpokenText(text: string, rules: SpeechDetectionRules): string | null {
  const cleaned = sanitizeForTts(text)
  if (!cleaned) return null
  const segments = parseSegments(cleaned, rules)
  const spoken = segments
    .filter((s) => s.action !== 'skip')
    .map((s) => s.text)
    .join(' ')
    .trim()
  return spoken || null
}
