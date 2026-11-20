import type { SpeechDetectionRules } from '@/types/store'

export type SegmentType = 'asterisked' | 'quoted' | 'undecorated'
/**
 * What to do with a parsed segment:
 *   - 'speech'    → read by the speaker's character voice
 *   - 'narration' → read by the narrator voice (falls back to speech)
 *   - 'thought'   → read by the speaker's character voice. Distinct from
 *                   'speech' because thoughts belong to a character but are
 *                   typically asterisked rather than quoted, and a future
 *                   thought-specific voice setting can branch on this tag
 *                   without re-classifying everything else.
 *   - 'skip'      → don't read
 */
export type SegmentAction = 'speech' | 'narration' | 'thought' | 'skip'

/**
 * HTML wrappers whose inner text is prose that SHOULD be spoken. Their
 * markers and attributes are stripped. Other paired tags are treated as
 * metadata and dropped with their contents; standalone non-HTML markers
 * can be inline audio cues.
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

/** HTML elements with no inner content. Removing them must not truncate prose. */
const VOID_HTML_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr',
])

/** HTML that isn't spoken prose and must never be mistaken for an audio cue. */
const NON_PROSE_HTML_TAGS = new Set([
  'html', 'head', 'body', 'title', 'script', 'style', 'noscript', 'template',
  'slot', 'canvas', 'svg', 'math', 'details', 'summary', 'dialog',
  'form', 'button', 'select', 'option', 'optgroup', 'textarea', 'datalist',
  'output', 'progress', 'meter', 'audio', 'video', 'picture', 'map',
  'object', 'iframe', 'frameset', 'frame', 'noframes', 'applet', 'basefont',
  'center',
])

/** Known metadata also needs filtering when a response leaves a block unclosed. */
const METADATA_TAG_RE = /^(?:think|thinking|reasoning|analysis|redacted_thinking|tracker|stats|status|state|(?:loom|tool|function)(?:[_-][\w-]+)?)$/i
/** Cue names are open-ended; HTML attributes and dialogue delimiters aren't cues. */
const AUDIO_CUE_RE = /^<[a-z][\w-]*(?:\s+[^<>=\/"*]+)?\s*\/?>$/i

/** Quoted attribute values can themselves contain `>` characters. */
const TAG_ATTRIBUTES = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?`
/** Match inner pairs first when metadata nests another block with the same name. */
const PAIRED_TAG_RE = new RegExp(String.raw`<([a-z][\w-]*)${TAG_ATTRIBUTES}>((?:(?!<\1${TAG_ATTRIBUTES}>)[\s\S])*?)<\/\1\s*>`, 'gi')
/** Self-closing: requires a `/` before the closing `>`. */
const SELF_CLOSING_RE = new RegExp(String.raw`<([a-z][\w-]*)${TAG_ATTRIBUTES}\s*\/\s*>`, 'gi')
/** Any opening tag (used to find the first unclosed non-prose tag). */
const OPENING_TAG_RE = new RegExp(String.raw`<([a-z][\w-]*)${TAG_ATTRIBUTES}>`, 'gi')
/** Closing marker `</TAG>`. */
const CLOSING_TAG_RE = /<\/([a-z][\w-]*)\s*>/gi
/** HTML or cue marker; whether it survives depends on its syntax and context. */
const ANY_TAG_MARKER_RE = new RegExp(String.raw`<\/?([a-z][\w-]*)${TAG_ATTRIBUTES}\s*\/?>`, 'gi')

const FENCED_CODE_RE = /```[\s\S]*?```/g
const INLINE_CODE_RE = /`[^`\n]*`/g
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g
const DOCTYPE_RE = /<!doctype\b[^>]*>/gi
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

const FISH_DELIVERY_TAGS = 'whisper|emphasis|soft|fast|slow|stress|forceful|french|spanish|german|japanese|chinese|korean|italian'
const FISH_TAG_MARKER_RE = new RegExp(`<\\/?(${FISH_DELIVERY_TAGS})\\s*>`, 'gi')
const FISH_CONTROL_RE = new RegExp(`<\\/?(?:${FISH_DELIVERY_TAGS})\\s*>|<\\|(?:speaker:\\d+|phoneme_start|phoneme_end)\\|>|\\[[^\\]\\r\\n]+\\]`, 'gi')
const FISH_SPECIAL_MARKER_RE = /<\|(?:speaker:\d+|phoneme_start|phoneme_end)\|>/g

export interface TtsTextOptions {
  preserveAudioCues?: boolean
  /** The selected Fish model determines which text controls survive. */
  fishModel?: string
  /** Strip Fish directions when a mixed-provider segment uses another voice. */
  stripFishDirections?: boolean
}

function usesFishDirections(model?: string): boolean {
  return ['s2-pro', 's2.1-pro', 's2.1-pro-free', 'drama-3-preview'].includes(model || '')
}

/** Hide only marker syntax; their contents still pass through metadata cleanup. */
function protectMarkers(text: string, pattern: RegExp) {
  let prefix = '\uE000TTS'
  while (text.includes(prefix)) prefix += '_'
  const markers = new Map<string, string>()
  const protectedText = text.replace(pattern, (marker) => {
    const placeholder = `${prefix}${markers.size}\uE001`
    markers.set(placeholder, marker)
    return placeholder
  })
  return {
    text: protectedText,
    markers,
    split: new RegExp(`(${prefix}\\d+\uE001)`, 'g'),
    restore: (value: string) => {
      for (const [placeholder, marker] of markers) value = value.replaceAll(placeholder, marker)
      return value
    },
  }
}

function isProse(tag: string): boolean {
  return PROSE_TAGS.has(tag.toLowerCase())
}

function isAudioCue(marker: string, tag: string): boolean {
  const name = tag.toLowerCase()
  return !isProse(name)
    && !VOID_HTML_TAGS.has(name)
    && !NON_PROSE_HTML_TAGS.has(name)
    && !METADATA_TAG_RE.test(name)
    && AUDIO_CUE_RE.test(marker)
}

/** Strip retained inline cues when a segment uses a plain-text TTS provider. */
export function stripTtsAudioCues(text: string): string {
  return text.replace(FISH_TAG_MARKER_RE, ' ')
    .replace(FISH_SPECIAL_MARKER_RE, ' ')
    .replace(ANY_TAG_MARKER_RE, (match, tag) => isAudioCue(match, tag) ? ' ' : match)
    .replace(/\s+/g, ' ').trim()
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
  return text.replace(SELF_CLOSING_RE, (match, tag) => (isProse(tag) || isAudioCue(match, tag) ? match : ' '))
}

/**
 * Drop unfinished metadata from its opening tag to end-of-input. Standalone
 * cue markers are exempt; walk past them to find any actual metadata block.
 */
function stripTrailingUnclosedNonProseTag(text: string): string {
  // A paired block remaining after the bounded sweep is still metadata, even
  // if its unknown name could otherwise look like a standalone cue.
  const closingTags = new Set(Array.from(text.matchAll(CLOSING_TAG_RE), (match) => match[1].toLowerCase()))
  OPENING_TAG_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = OPENING_TAG_RE.exec(text)) !== null) {
    if (!isProse(match[1]) && (!isAudioCue(match[0], match[1]) || closingTags.has(match[1].toLowerCase()))) {
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
 * Unwrap prose HTML, then drop metadata blocks and non-prose HTML. Standalone
 * non-HTML markers without attributes are audio cues, regardless of their
 * names. They never truncate the message and are retained only when requested
 * by a provider that understands them. Unfinished metadata still drops the
 * remainder of the message.
 */
export function sanitizeForTts(text: string, options: TtsTextOptions = {}): string {
  let out = text

  // 1. Strip code first so `<` inside code can't be misread as tag syntax.
  out = out.replace(FENCED_CODE_RE, ' ')
  out = out.replace(INLINE_CODE_RE, ' ')
  out = out.replace(HTML_COMMENT_RE, ' ')
  out = out.replace(DOCTYPE_RE, ' ')

  // Drama's paired delivery/language tags contain spoken prose. Protect their
  // markers for Drama and unwrap them for other voices before metadata sweeps.
  const fishMarkers = protectMarkers(out, FISH_TAG_MARKER_RE)
  out = options.fishModel === 'drama-3-preview'
    ? fishMarkers.text
    : out.replace(FISH_TAG_MARKER_RE, ' ')

  // Unwrap HTML before block sweeps so nested font/span wrappers don't hide
  // metadata inside prose containers. Void elements have no contents to drop.
  out = out.replace(ANY_TAG_MARKER_RE, (match, tag) => (
    isProse(tag) || VOID_HTML_TAGS.has(tag.toLowerCase()) ? ' ' : match
  ))

  // 2. Tag sweeps. Paired → self-closing → unclosed trailing → stray closings.
  out = stripNonProsePairedTags(out)
  out = stripNonProseSelfClosingTags(out)
  out = stripTrailingUnclosedNonProseTag(out)
  out = stripStrayNonProseClosings(out)

  // 3. Markdown: images dropped entirely, links reduced to their label text.
  out = out.replace(MD_IMAGE_RE, ' ')
  out = out.replace(MD_LINK_RE, '$1')
  if (options.stripFishDirections && !usesFishDirections(options.fishModel)) {
    out = out.replace(/\[[^\]\r\n]+\]/g, ' ')
  }
  if (!options.fishModel) out = out.replace(FISH_SPECIAL_MARKER_RE, ' ')

  // 4. Only standalone cue markers can survive the HTML/metadata sweeps.
  out = out.replace(ANY_TAG_MARKER_RE, (match, tag) => (
    options.preserveAudioCues && isAudioCue(match, tag) ? match : ' '
  ))

  // 5. Decode a handful of common HTML entities so they're pronounced, not spelled.
  out = out.replace(HTML_ENTITY_RE, (m) => HTML_ENTITY_MAP[m] ?? m)

  // 6. Collapse whitespace (including newlines) into single spaces.
  out = out.replace(/\s+/g, ' ').trim()

  return fishMarkers.restore(out)
}

export interface TextSegment {
  text: string
  type: SegmentType
  action: SegmentAction
}

function resolveAction(type: SegmentType, rules: SpeechDetectionRules): SegmentAction {
  switch (type) {
    case 'asterisked':
      return rules.asterisked
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
export function parseSegments(text: string, rules: SpeechDetectionRules, options: TtsTextOptions = {}): TextSegment[] {
  const fishControls = usesFishDirections(options.fishModel) ? protectMarkers(text, FISH_CONTROL_RE) : null
  const parseText = fishControls?.text ?? text
  const pattern = /\*([^*]+)\*|["“]([^"”]+)["”]|([^*"“”]+)/g
  const raw: TextSegment[] = []

  let match: RegExpExecArray | null
  while ((match = pattern.exec(parseText)) !== null) {
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

  // Direction-only prefixes belong to the next spoken span. Paired scopes can
  // cross dialogue/narration boundaries; balance them in each resulting span
  // so every voice receives a complete instruction, even after skipped text.
  if (fishControls) {
    const activeTags: string[] = []
    const pending: string[] = []
    const directed: TextSegment[] = []
    for (let index = 0; index < raw.length; index++) {
      const segment = raw[index]
      const parts = segment.text.split(fishControls.split).filter(Boolean)
      const lastWordIndex = parts.findLastIndex((piece) => !fishControls.markers.has(piece) && !!piece.trim())
      const previousDirections = [...pending]
      const localTags: string[] = []
      let output = ''
      let hasWords = false
      const beginWords = () => {
        if (hasWords) return
        localTags.push(...activeTags)
        output += activeTags.map((tag) => `<${tag}>`).join('')
        if (pending.length) output += pending.splice(0).join(' ') + ' '
        hasWords = true
      }
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex]
        const marker = fishControls.markers.get(part)
        if (!marker) {
          if (part.trim()) beginWords()
          if (hasWords) output += part
          continue
        }
        const tag = /^<(\/)?([a-z]+)\s*>$/i.exec(marker)
        const wordsFollow = partIndex < lastWordIndex
        if (tag) {
          const name = tag[2].toLowerCase()
          if (!tag[1]) {
            activeTags.push(name)
            if (hasWords && wordsFollow) {
              localTags.push(name)
              output += `<${name}>`
            }
          } else {
            const activeIndex = activeTags.lastIndexOf(name)
            if (activeIndex !== -1) activeTags.splice(activeIndex)
            const localIndex = localTags.lastIndexOf(name)
            if (localIndex !== -1) output += localTags.splice(localIndex).reverse().map((name) => `</${name}>`).join('')
          }
        } else if (marker.startsWith('[') || marker.startsWith('<|speaker:')) {
          const defer = segment.type === 'undecorated' && index + 1 < raw.length && !wordsFollow
          if (!hasWords || defer) pending.push(marker)
          else output += marker
        } else {
          beginWords()
          output += marker
        }
      }
      if (hasWords) {
        output += localTags.reverse().map((name) => `</${name}>`).join('')
        directed.push({ ...segment, text: output.trim() })
      }
      if (segment.action === 'skip') pending.splice(0, pending.length, ...previousDirections)
    }
    raw.splice(0, raw.length, ...directed)
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
