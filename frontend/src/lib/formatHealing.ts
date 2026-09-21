function getFencedCodeRanges(text: string): Array<[number, number]> {
  if (!text.includes('```') && !text.includes('~~~')) return []
  const lines = text.split('\n')
  type ClosingLines = { lines: Array<{ line: number; end: number }>; next: number }
  const closers = [new Map<number, ClosingLines>(), new Map<number, ClosingLines>()]
  const openers: Array<{ line: number; start: number; marker: number; length: number }> = []
  let offset = 0
  for (let line = 0; line < lines.length; line++) {
    const match = /^(`{3,}|~{3,})/.exec(lines[line])
    if (match) {
      const length = match[0].length
      const marker = match[0][0] === '`' ? 0 : 1
      if (lines[line].length === length) {
        let group = closers[marker].get(length)
        if (!group) {
          group = { lines: [], next: 0 }
          closers[marker].set(length, group)
        }
        group.lines.push({ line, end: offset + length })
      }
      if (line + 1 < lines.length) openers.push({ line, start: offset === 0 ? 0 : offset - 1, marker, length })
    }
    offset += lines[line].length + 1
  }
  const ranges: Array<[number, number]> = []
  let consumed = 0
  for (const open of openers) {
    if (open.start < consumed) continue
    // The old greedy opener prefers the longest matching run before choosing its earliest close.
    for (let length = open.length; length >= 3; length--) {
      const group = closers[open.marker].get(length)
      if (!group) continue
      while (group.next < group.lines.length && group.lines[group.next].line < open.line + 2) group.next++
      const close = group.lines[group.next]
      if (!close) continue
      ranges.push([open.start, close.end])
      consumed = close.end
      break
    }
  }
  return ranges
}

function getInlineCodeRanges(text: string): Array<[number, number]> {
  const runs = Array.from(text.matchAll(/`+/g), match => ({
    start: match.index!, end: match.index! + match[0].length, longestAfter: 0,
  }))
  let longest = 0
  for (let index = runs.length - 1; index >= 0; index--) {
    runs[index].longestAfter = longest
    longest = Math.max(longest, runs[index].end - runs[index].start)
  }
  const ranges: Array<[number, number]> = []
  for (let index = 0; index < runs.length;) {
    const open = runs[index]
    const start = open.start
    const length = open.end - start
    // Match the longest opener that can close, including inside its own run.
    const marker = Math.max(Math.floor(length / 2), Math.min(length, open.longestAfter))
    if (!marker) break
    let end = start + marker * 2
    if (end > open.end) {
      do { index++ } while (runs[index].end - runs[index].start < marker)
      end = runs[index].start + marker
    }
    ranges.push([start, end])
    if (end === runs[index].end) index++
    else runs[index].start = end
  }
  return ranges
}
const FONT_QUOTE_EDGE_RE = /(<font\b[^>]*>)(["“”«»])([\s\S]*?)(?:(<\/font>)(["“”«»])|$)|<font\b[^>]*(?:>|$)/gi
const FONT_TAG_RE = /<\/?font\b[^>]*(>|$)/gi
const QUOTE_CHARS = new Set(['"', '“', '”', '«', '»'])
const MATCHING_QUOTE: Record<string, string> = {
  '"': '"',
  '“': '”',
  '«': '»',
}
const STRAIGHT_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(")([^\n]*?)(?:(")(?=$|[\s)\]},.!?:;"'”’»<—–-])|(?=\n|$))/g
const CURLY_DOUBLE_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(“)([^\n]*?)(?:(”)(?=$|[\s)\]},.!?:;"'”’»<—–-])|(?=\n|$))/g
const ANGLE_QUOTE_RE = /(^|[\s([{"'“‘«>—–-])(«)([^\n]*?)(?:(»)(?=$|[\s)\]},.!?:;"'”’»<—–-])|(?=\n|$))/g

function repairQuotedColorTagBoundaries(text: string): string {
  const repair = (
    match: string,
    openTag: string,
    openQuote: string,
    inner: string,
    closeTag: string,
    closeQuote: string,
  ) => {
    if (!closeTag) return match
    const trimmedInner = inner.trimEnd()
    const lastChar = trimmedInner[trimmedInner.length - 1]
    if (lastChar && QUOTE_CHARS.has(lastChar)) return match
    return `${openTag}${openQuote}${inner}${closeQuote}${closeTag}`
  }

  const healed = text.replace(FONT_QUOTE_EDGE_RE, repair)
  const firstSpan = /<span\b/i.exec(healed)
  if (!firstSpan) return healed

  const candidates = new Map<number, { start: number; end: number; close: RegExpExecArray }>()
  const stylePattern = /\bstyle\s*=\s*["']/gi
  stylePattern.lastIndex = firstSpan.index + firstSpan[0].length
  const quotePattern = /["']/g
  const closingPattern = /<\/span>(["“”«»])/gi
  let firstEnd = -1
  let openingEnd = -1
  let closing: RegExpExecArray | null = null
  let style: RegExpExecArray | null
  while ((style = stylePattern.exec(healed)) !== null) {
    if (firstEnd < stylePattern.lastIndex) firstEnd = healed.indexOf('>', stylePattern.lastIndex)
    if (firstEnd < 0) break
    quotePattern.lastIndex = stylePattern.lastIndex
    const quote = quotePattern.exec(healed)
    if (!quote) break
    if (!/\bcolor\s*:/i.test(healed.slice(stylePattern.lastIndex, quote.index))) continue
    if (openingEnd <= quote.index) openingEnd = healed.indexOf('>', quote.index + 1)
    if (openingEnd < 0) break
    if (!QUOTE_CHARS.has(healed[openingEnd + 1])) continue
    if (!closing || closing.index < openingEnd + 2) {
      closingPattern.lastIndex = openingEnd + 2
      closing = closingPattern.exec(healed)
      if (!closing) break
    }
    // The existing greedy attribute match chooses the last eligible style before this delimiter.
    candidates.set(firstEnd, { start: style.index, end: openingEnd, close: closing })
  }

  const openingPattern = /<span\b/gi
  let end = -1
  let cursor = 0
  let result = ''
  let opening: RegExpExecArray | null
  while ((opening = openingPattern.exec(healed)) !== null) {
    if (end < openingPattern.lastIndex) end = healed.indexOf('>', openingPattern.lastIndex)
    if (end < 0) break
    const candidate = candidates.get(end)
    if (!candidate || candidate.start < openingPattern.lastIndex) continue
    const closeEnd = candidate.close.index + candidate.close[0].length
    result += healed.slice(cursor, opening.index)
    result += repair(
      healed.slice(opening.index, closeEnd),
      healed.slice(opening.index, candidate.end + 1),
      healed[candidate.end + 1],
      healed.slice(candidate.end + 2, candidate.close.index),
      candidate.close[0].slice(0, -1),
      candidate.close[1],
    )
    cursor = closeEnd
    openingPattern.lastIndex = closeEnd
  }
  return result + healed.slice(cursor)
}

/** Repair `<font color="abc>` into a valid opening tag before balancing it. */
function repairUnterminatedFontColorQuotes(text: string): string {
  return text.replace(
    /<font\b(?:([^>]*?\bcolor\s*=\s*)(["'])([^"'>]*)(>)|[^>]*(?:>|$))/gi,
    (match, before: string, quote: string, value: string, end: string) => end
      ? `<font${before}${quote}${value}${quote}>`
      : match,
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
  const tokens: Array<{ index: number; end: number; closing: boolean }> = []
  for (const match of text.matchAll(FONT_TAG_RE)) {
    if (!match[1]) break
    tokens.push({
      index: match.index!,
      end: match.index! + match[0].length,
      closing: /^<\/font\b/i.test(match[0]),
    })
  }
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
      `(^|[\\s([{"'“‘«>—–-])(${marker})(?!\\${delimiter})([^\\n]*?)(?:(${marker})(?!\\${delimiter})(?=$|[\\s)\\]},.!?:;"'”’»<—–-])|(?=\\n|$))`,
      'g',
    )
    result = result.replace(pattern, (match, prefix: string, openingMarker: string, body: string, closingMarker: string) => {
      if (!closingMarker) return match
      if (!/^[ \t]|[ \t]$/.test(body)) return match
      if (body.includes(delimiter)) return match
      const trimmed = body.replace(/^[ \t]+|(?<![ \t])[ \t]+$/g, '')
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
      if (!closeQuote) return match
      if (!/^[ \t]|[ \t]$/.test(body)) return match
      const trimmed = body.replace(/^[ \t]+|(?<![ \t])[ \t]+$/g, '')
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
function healAroundInlineCode(text: string): string {
  let healed = ''
  let cursor = 0

  for (const [start, end] of getInlineCodeRanges(text)) {
    healed += healUnshieldedSegment(text.slice(cursor, start))
    healed += text.slice(start, end)
    cursor = end
  }

  return healed + healUnshieldedSegment(text.slice(cursor))
}

export function healFormattingArtifacts(text: string): string {
  if (!text) return text

  // Process fenced blocks first so inline-code matching cannot see their
  // backticks. Inline spans are then protected in each prose segment.
  let healed = ''
  let cursor = 0
  for (const [start, end] of getFencedCodeRanges(text)) {
    healed += healAroundInlineCode(text.slice(cursor, start))
    healed += text.slice(start, end)
    cursor = end
  }
  return healed + healAroundInlineCode(text.slice(cursor))
}
