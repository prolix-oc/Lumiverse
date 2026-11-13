/**
 * Valid `<json>…</json>` blocks in a message's own text are machine-readable
 * state that the backend keeps byte-for-byte through every macro pass, so
 * display helpers skip them by the same rules as `findTopLevelJsonBlocks` in
 * src/macros/json-blocks.ts: `<json>` (any case, no attributes) up to the first
 * `</json>` outside a JSON string, valid only when the text between parses as
 * JSON, and outside every macro tag. A block inside a tag, as in
 * `{{setvar::x::<json>…</json>}}`, is ordinary text, so a display setter strips
 * the whole tag. Past the scan's rejection cap, the rest of the text is
 * unclassified: the backend runs no macro pass over such a message, and its
 * healer leaves the rest as written, so display keeps the rest verbatim too.
 */

export interface JsonBlockSegment {
  text: string
  /**
   * True for text the backend keeps as written: a whole valid block, tags
   * included, or the rest of a text past the scan's rejection cap.
   */
  verbatim: boolean
}

interface BlockRange {
  start: number
  end: number
}

interface BlockScan {
  blocks: BlockRange[]
  /** The text's length, or the opener of the candidate that reached the rejection cap. */
  stoppedAt: number
}

const HAS_OPEN_TAG_RE = /<json>/i
const OPEN_TAG_RE = /<json>/gi
// Either tag, tested where a `<` sits.
const TAG_AT_RE = /<\/?json>/iy
const OPEN_TAG_LENGTH = '<json>'.length
const CLOSE_TAG_LENGTH = '</json>'.length
// JSON whitespace, then a character that can open a JSON value. The closing
// tag's `<` ends the match, so it never reads past the candidate's inner text.
const JSON_START_RE = /[ \t\n\r]*[-0-9"[{tfn]/y
const QUOTE = 0x22
const SLASH = 0x2f
const LESS_THAN = 0x3c
const BACKSLASH = 0x5c
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d
// Most candidates one scan may reject: the backend's cap, so display stops
// where the backend does. A rejection sends the scan back to just after
// the candidate's opener, so each one can cost a pass over the rest of the
// text; the cap keeps a scan linear. The candidate that reaches it stops the
// scan, and the rest of the text stays verbatim; only crafted text gets that far.
const MAX_REJECTED_CANDIDATES = 256

export function splitJsonBlocks(text: string): JsonBlockSegment[] {
  const segments: JsonBlockSegment[] = []
  const { blocks, stoppedAt } = findTopLevelJsonBlocks(text)
  let cursor = 0
  for (const block of blocks) {
    if (block.start > cursor) segments.push({ text: text.slice(cursor, block.start), verbatim: false })
    segments.push({ text: text.slice(block.start, block.end), verbatim: true })
    cursor = block.end
  }
  if (stoppedAt > cursor) segments.push({ text: text.slice(cursor, stoppedAt), verbatim: false })
  if (stoppedAt < text.length) segments.push({ text: text.slice(stoppedAt), verbatim: true })
  return segments
}

/**
 * Applies `transform` to the text around valid blocks outside macro tags; the
 * blocks, and any text past the scan's rejection cap, stay verbatim.
 */
export function mapOutsideJsonBlocks(text: string, transform: (text: string) => string): string {
  if (!HAS_OPEN_TAG_RE.test(text)) return transform(text)
  return splitJsonBlocks(text)
    .map((segment) => (segment.verbatim ? segment.text : transform(segment.text)))
    .join('')
}

/**
 * The valid blocks outside every macro tag, and where the scan stopped. From
 * a `<json>`, the scan follows JSON strings (quotes and backslash escapes) to
 * the first `</json>` outside one. A valid candidate is a block, and the scan
 * goes on after its closer. A `<json>` outside a string ends the candidate
 * unparsed, since JSON never has a `<` there, and the scan goes on from that
 * opener. An invalid candidate, or one with no closer, sends the scan back to
 * just after its opener, so a later opener inside one of its strings can still
 * start a block.
 *
 * An opener inside a macro tag starts no candidate. The lexer reads it as the
 * tag's text, so the scan counts tags through it and looks for openers in it
 * as in any other text; only the blocks it finds are skipped, since the
 * backend keeps them from the lexer.
 */
function findTopLevelJsonBlocks(text: string): BlockScan {
  const blocks: BlockRange[] = []
  let rejected = 0
  // Macro tag nesting at `counted`.
  let depth = 0
  let counted = 0
  let open = indexOfOpenTag(text, 0)
  while (open >= 0) {
    const innerStart = open + OPEN_TAG_LENGTH
    depth = macroDepthAt(text, counted, open, depth)
    if (depth < 0) return { blocks: [], stoppedAt: 0 }
    counted = open
    if (depth > 0) {
      open = indexOfOpenTag(text, innerStart)
      continue
    }
    const tag = indexOfTagOutsideStrings(text, innerStart)
    if (tag >= 0 && text.charCodeAt(tag + 1) !== SLASH) {
      open = tag
      continue
    }
    if (tag >= 0 && isJson(text, innerStart, tag)) {
      const end = tag + CLOSE_TAG_LENGTH
      blocks.push({ start: open, end })
      counted = end
      open = indexOfOpenTag(text, end)
    } else if (++rejected === MAX_REJECTED_CANDIDATES) {
      return { blocks, stoppedAt: open }
    } else {
      open = indexOfOpenTag(text, innerStart)
    }
  }
  return { blocks, stoppedAt: text.length }
}

function indexOfOpenTag(text: string, from: number): number {
  OPEN_TAG_RE.lastIndex = from
  return OPEN_TAG_RE.test(text) ? OPEN_TAG_RE.lastIndex - OPEN_TAG_LENGTH : -1
}

/** Offset of the first `<json>` or `</json>` outside a JSON string, or -1. */
function indexOfTagOutsideStrings(text: string, from: number): number {
  let inString = false
  for (let i = from; i < text.length; i++) {
    const char = text.charCodeAt(i)
    if (inString) {
      if (char === BACKSLASH) i++
      else if (char === QUOTE) inString = false
    } else if (char === QUOTE) {
      inString = true
    } else if (char === LESS_THAN) {
      TAG_AT_RE.lastIndex = i
      if (TAG_AT_RE.test(text)) return i
    }
  }
  return -1
}

function isJson(text: string, start: number, end: number): boolean {
  // Text that cannot start JSON is no block, and telling needs no parse.
  JSON_START_RE.lastIndex = start
  if (!JSON_START_RE.test(text)) return false
  try {
    JSON.parse(text.slice(start, end))
    return true
  } catch {
    return false
  }
}

/**
 * Macro tag nesting at `to`, given `depth` at `from`, read as the macro lexer
 * reads text: `\{` and `\}` are literal braces, `{{` opens a tag, and `}}`
 * closes one; outside every tag, `}}` is plain text. No pair spans either
 * end: each is the text's start, an opener's `<`, or just past a block's `>`.
 */
function macroDepthAt(text: string, from: number, to: number, depth: number): number {
  for (let i = from; i < to; i++) {
    const char = text.charCodeAt(i)
    const next = text.charCodeAt(i + 1)
    if (char === BACKSLASH && (next === OPEN_BRACE || next === CLOSE_BRACE)) {
      i++
    } else if (char === OPEN_BRACE && next === OPEN_BRACE) {
      if (malformedShorthandAt(text, i, to)) return -1
      depth++
      i++
    } else if (char === CLOSE_BRACE && next === CLOSE_BRACE && depth > 0) {
      depth--
      i++
    }
  }
  return depth
}

/** Match the lexer's shorthand header; an uncertain early close fails closed. */
function malformedShorthandAt(text: string, start: number, to: number): boolean {
  const header = /^[ \t]*[!?~>/#]*[ \t]*[.@$]/.exec(text.slice(start + 2, to))
  if (!header) return false
  let pos = start + 2 + header[0].length
  while (pos < to && /[\w-]/.test(text[pos])) {
    if (text[pos] === '-' && (text[pos + 1] === '-' || text[pos + 1] === '=')) break
    pos++
  }
  while (pos < to && (text[pos] === ' ' || text[pos] === '\t')) pos++
  const operator = text.slice(pos, pos + 2)
  if (['+=', '-=', '||', '??', '==', '!=', '>=', '<='].includes(operator) || ['=', '>', '<'].includes(text[pos])) return false
  if (operator === '++' || operator === '--') {
    pos += 2
    while (pos < to && (text[pos] === ' ' || text[pos] === '\t')) pos++
  }
  return pos <= to && text.slice(pos, pos + 2) !== '}}'
}
