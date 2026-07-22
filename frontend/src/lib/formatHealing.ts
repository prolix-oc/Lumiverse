const FENCED_CODE_RE = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g
const INLINE_CODE_RE = /(`+)([\s\S]*?)\1/g
const FONT_QUOTE_EDGE_RE = /(<font\b[^>]*>)(["“”«»])([\s\S]*?)(<\/font>)(["“”«»])/gi
const COLOR_SPAN_QUOTE_EDGE_RE = /(<span\b[^>]*\bstyle\s*=\s*["'][^"']*\bcolor\s*:[^"']*["'][^>]*>)(["“”«»])([\s\S]*?)(<\/span>)(["“”«»])/gi
const FONT_TAG_RE = /<\/?font\b[^>]*>/gi
const QUOTE_CHARS = new Set(['"', '“', '”', '«', '»'])
const MATCHING_QUOTE: Record<string, string> = {
  '"': '"',
  '“': '”',
  '«': '»',
}
const STRAIGHT_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(")([^\n]*?)(")(?=$|[\s)\]},.!?:;"'”’»<—–-])/g
const CURLY_DOUBLE_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(“)([^\n]*?)(”)(?=$|[\s)\]},.!?:;"'”’»<—–-])/g
const ANGLE_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(«)([^\n]*?)(»)(?=$|[\s)\]},.!?:;"'”’»<—–-])/g

function repairQuotedColorTagBoundaries(text: string): string {
  const repair = (
    match: string,
    openTag: string,
    openQuote: string,
    inner: string,
    closeTag: string,
    closeQuote: string,
  ) => {
    const trimmedInner = inner.trimEnd()
    const lastChar = trimmedInner[trimmedInner.length - 1]
    if (lastChar && QUOTE_CHARS.has(lastChar)) return match
    return `${openTag}${openQuote}${inner}${closeQuote}${closeTag}`
  }

  let healed = text.replace(FONT_QUOTE_EDGE_RE, repair)
  healed = healed.replace(COLOR_SPAN_QUOTE_EDGE_RE, repair)
  return healed
}

/** Repair `<font color="abc>` into a valid opening tag before balancing it. */
function repairUnterminatedFontColorQuotes(text: string): string {
  return text.replace(
    /<font\b([^>]*?\bcolor\s*=\s*)(["'])([^"'>]*)(>)/gi,
    (_match, before: string, quote: string, value: string) =>
      `<font${before}${quote}${value}${quote}>`,
  )
}

function findUnescapedChar(text: string, target: string, from: number): number {
  for (let index = from; index < text.length; index++) {
    if (text[index] !== target) continue
    let backslashes = 0
    for (let before = index - 1; before >= 0 && text[before] === '\\'; before--) {
      backslashes++
    }
    if (backslashes % 2 === 0) return index
  }
  return -1
}

/**
 * Finds the natural end of a dialogue or action wrapped by a font tag. The
 * fallback is the next font token/end of the message, which contains a broken
 * tag's color scope instead of allowing it to bleed into later prose.
 */
function findFontScopeBoundary(segment: string): number {
  const leadingWhitespace = segment.match(/^\s*/)?.[0].length ?? 0
  const opener = segment[leadingWhitespace]
  const closingQuote = opener ? MATCHING_QUOTE[opener] : undefined

  if (closingQuote) {
    const closingIndex = findUnescapedChar(
      segment,
      closingQuote,
      leadingWhitespace + 1,
    )
    if (closingIndex >= 0) return closingIndex + 1
  }

  if (opener === '*') {
    const markerLength = segment.startsWith('***', leadingWhitespace)
      ? 3
      : segment.startsWith('**', leadingWhitespace)
        ? 2
        : 1
    const marker = '*'.repeat(markerLength)
    const closingIndex = segment.indexOf(marker, leadingWhitespace + markerLength)
    if (closingIndex >= 0) return closingIndex + markerLength
  }

  return segment.length
}

/**
 * Close only font tags that have no matching closing tag. Finished dialogue
 * and markdown action spans get the tightest possible scope; otherwise the
 * tag closes before the next font tag or at the message end.
 */
function closeUnterminatedFontTags(text: string): string {
  const tokens = [...text.matchAll(FONT_TAG_RE)].map((match) => ({
    index: match.index!,
    end: match.index! + match[0].length,
    closing: /^<\/font\b/i.test(match[0]),
  }))
  if (tokens.length === 0) return text

  const openStack: number[] = []
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].closing) openStack.pop()
    else openStack.push(index)
  }
  if (openStack.length === 0) return text

  const insertions = new Map<number, number>()
  for (const openIndex of openStack) {
    const open = tokens[openIndex]
    const nextToken = tokens[openIndex + 1]
    const segmentEnd = nextToken?.index ?? text.length
    const segment = text.slice(open.end, segmentEnd)
    const boundary = open.end + findFontScopeBoundary(segment)
    insertions.set(boundary, (insertions.get(boundary) ?? 0) + 1)
  }

  let healed = ''
  let cursor = 0
  for (const [index, count] of [...insertions.entries()].sort(([a], [b]) => a - b)) {
    healed += text.slice(cursor, index)
    healed += '</font>'.repeat(count)
    cursor = index
  }
  return healed + text.slice(cursor)
}

function trimEdgeWhitespaceInEmphasis(text: string, delimiter: '*' | '_'): string {
  const delimiters = [3, 2, 1] as const
  let result = text

  for (const size of delimiters) {
    const marker = delimiter.repeat(size).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `(^|[\\s([{"'“‘«>—–-])(${marker})(?!\\${delimiter})([^\\n]*?)${marker}(?!\\${delimiter})(?=$|[\\s)\\]},.!?:;"'”’»<—–-])`,
      'g',
    )
    result = result.replace(pattern, (match, prefix: string, openingMarker: string, body: string) => {
      if (!/^[ \t]+|[ \t]+$/.test(body)) return match
      if (body.includes(delimiter)) return match
      const trimmed = body.replace(/^[ \t]+|[ \t]+$/g, '')
      if (!trimmed) return match
      if (!/[\p{L}\p{N}]/u.test(trimmed)) return match
      return `${prefix}${openingMarker}${trimmed}${openingMarker}`
    })
  }

  return result
}

function trimEdgeWhitespaceInQuotes(text: string): string {
  const patterns = [STRAIGHT_QUOTE_RE, CURLY_DOUBLE_QUOTE_RE, ANGLE_QUOTE_RE]
  let result = text

  for (const pattern of patterns) {
    result = result.replace(pattern, (match, prefix: string, openQuote: string, body: string, closeQuote: string) => {
      if (!/^[ \t]+|[ \t]+$/.test(body)) return match
      const trimmed = body.replace(/^[ \t]+|[ \t]+$/g, '')
      if (!trimmed) return match
      if (!/[\p{L}\p{N}]/u.test(trimmed)) return match
      return `${prefix}${openQuote}${trimmed}${closeQuote}`
    })
  }

  return result
}

function healUnshieldedSegment(text: string): string {
  let healed = repairUnterminatedFontColorQuotes(text)
  healed = closeUnterminatedFontTags(healed)
  healed = repairQuotedColorTagBoundaries(healed)
  for (let i = 0; i < 2; i++) {
    const next = trimEdgeWhitespaceInQuotes(trimEdgeWhitespaceInEmphasis(trimEdgeWhitespaceInEmphasis(healed, '*'), '_'))
    if (next === healed) break
    healed = next
  }
  return healed
}

/**
 * Applies formatting healing only to prose between protected markdown spans.
 * Keeping protected content out of the working string avoids temporary marker
 * tokens leaking into user content when an intermediate string is normalized.
 */
function healAroundMatches(text: string, pattern: RegExp): string {
  let healed = ''
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    const index = match.index!
    healed += healUnshieldedSegment(text.slice(cursor, index))
    healed += match[0]
    cursor = index + match[0].length
  }

  return healed + healUnshieldedSegment(text.slice(cursor))
}

export function healFormattingArtifacts(text: string): string {
  if (!text) return text

  // Process fenced blocks first so inline-code matching cannot see their
  // backticks. Inline spans are then protected in each prose segment.
  let healed = ''
  let cursor = 0
  for (const match of text.matchAll(FENCED_CODE_RE)) {
    const index = match.index!
    healed += healAroundMatches(text.slice(cursor, index), INLINE_CODE_RE)
    healed += match[0]
    cursor = index + match[0].length
  }
  return healed + healAroundMatches(text.slice(cursor), INLINE_CODE_RE)
}
