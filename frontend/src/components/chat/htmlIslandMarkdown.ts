const STYLE_PLACEHOLDER_RE = /^<!--ISLAND_STYLE_\d+-->$/
const VOID_HTML_TAG_RE = /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i
const RAW_TEXT_CONTEXT_TAGS = new Set(['code', 'pre', 'script'])
const NO_MARKDOWN_SUBTREE_TAGS = new Set(['svg'])

// The sanitizer unwraps elements outside its allowlist while keeping their
// content, so unknown tags (card pseudo-markers like <close> or an unreplaced
// <Name: ...>) must not establish markdown context: an unclosed one would
// force inline rendering for the whole rest of the island. Snapshot of
// DOMPurify's default HTML allowlist minus richHtmlSanitizer's FORBID_TAGS;
// update alongside any tag-policy change there.
const SANITIZER_KEPT_TAGS = new Set([
  'a', 'abbr', 'acronym', 'address', 'area', 'article', 'aside', 'audio', 'b',
  'bdi', 'bdo', 'big', 'blink', 'blockquote', 'body', 'br', 'button', 'canvas',
  'caption', 'center', 'cite', 'code', 'col', 'colgroup', 'content', 'data',
  'datalist', 'dd', 'decorator', 'del', 'details', 'dfn', 'dialog', 'dir',
  'div', 'dl', 'dt', 'element', 'em', 'fieldset', 'figcaption', 'figure',
  'font', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hgroup', 'hr', 'html', 'i', 'img', 'input', 'ins', 'kbd', 'label',
  'legend', 'li', 'main', 'map', 'mark', 'marquee', 'menu', 'menuitem',
  'meter', 'nav', 'nobr', 'ol', 'optgroup', 'option', 'output', 'p', 'picture',
  'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'section', 'select',
  'shadow', 'small', 'source', 'spacer', 'span', 'strike', 'strong', 'style',
  'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template',
  'textarea', 'tfoot', 'th', 'thead', 'time', 'tr', 'track', 'tt', 'u', 'ul',
  'var', 'video', 'wbr',
])

// Sanitizer-kept tags that flow inside a paragraph. At block level these open
// a paragraph group (see processMarkdownInHtmlIsland) instead of standing
// alone; every other kept tag is a block boundary that closes the group.
const INLINE_FLOW_TAGS = new Set([
  'a', 'abbr', 'acronym', 'audio', 'b', 'bdi', 'bdo', 'big', 'blink', 'br',
  'button', 'cite', 'code', 'data', 'datalist', 'del', 'dfn', 'em', 'font',
  'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'marquee', 'meter',
  'nobr', 'optgroup', 'option', 'output', 'picture', 'progress', 'q', 'rp',
  'rt', 'ruby', 's', 'samp', 'select', 'small', 'source', 'spacer', 'span',
  'strike', 'strong', 'sub', 'sup', 'time', 'track', 'tt', 'u', 'var',
  'video', 'wbr',
])

export const ISLAND_BLANK_LINE_RE = /\n[^\S\n]*\n/
const BLANK_LINE_ALL_RE = /\n[^\S\n]*\n/g

// Only these containers are allowed to promote child text into block markdown
// like headings or lists. Everything else stays inline to avoid emitting
// invalid HTML such as <span><h1>…</h1></span>.
const BLOCK_MARKDOWN_PARENT_TAGS = new Set([
  'article',
  'aside',
  'blockquote',
  'body',
  'dd',
  'details',
  'div',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'header',
  'html',
  'li',
  'main',
  'nav',
  'section',
  'td',
  'th',
])

export interface HtmlIslandMarkdownRenderer {
  renderBlockText: (markdown: string) => string
  renderInlineText: (markdown: string) => string
  normalizeHtml?: (html: string) => string
}

interface TagStack {
  tags: string[]
  positions: Map<string, number[]>
}

function updateTagStack(part: string, tagStack: TagStack, rawTextState: { depth: number }): void {
  const closeMatch = part.match(/^<\/([a-z][\w:-]*)\b/i)
  if (closeMatch) {
    const tag = closeMatch[1].toLowerCase()
    if (RAW_TEXT_CONTEXT_TAGS.has(tag)) rawTextState.depth = Math.max(0, rawTextState.depth - 1)
    if (!SANITIZER_KEPT_TAGS.has(tag) || tagStack.tags.length === 0) return
    const idx = tagStack.positions.get(tag)?.pop()
    if (idx !== undefined) {
      // Closing a mismatched tag must not repeatedly shift its descendants.
      tagStack.tags[idx] = ''
      while (tagStack.tags[tagStack.tags.length - 1] === '') tagStack.tags.pop()
    }
    return
  }

  const openMatch = part.match(/^<([a-z][\w:-]*)\b/i)
  if (!openMatch) return

  const tag = openMatch[1].toLowerCase()
  if (RAW_TEXT_CONTEXT_TAGS.has(tag)) rawTextState.depth += 1
  if (!SANITIZER_KEPT_TAGS.has(tag)) return

  const isSelfClosing = /\/\s*>$/.test(part) || VOID_HTML_TAG_RE.test(part)
  if (!isSelfClosing) {
    let positions = tagStack.positions.get(tag)
    if (!positions) {
      positions = []
      tagStack.positions.set(tag, positions)
    }
    positions.push(tagStack.tags.length)
    tagStack.tags.push(tag)
  }
}

function shouldRenderInlineMarkdown(tagStack: TagStack): boolean {
  const currentTag = tagStack.tags[tagStack.tags.length - 1]
  return currentTag != null && !BLOCK_MARKDOWN_PARENT_TAGS.has(currentTag)
}

function isMarkdownExcludedSubtree(tagStack: TagStack): boolean {
  if (tagStack.tags.length === 0) return false
  for (const tag of NO_MARKDOWN_SUBTREE_TAGS) {
    if (tagStack.positions.get(tag)?.length) return true
  }
  return false
}

function findLastBlankLine(text: string): { index: number } | null {
  BLANK_LINE_ALL_RE.lastIndex = 0
  let last: { index: number } | null = null
  let m: RegExpExecArray | null
  while ((m = BLANK_LINE_ALL_RE.exec(text)) !== null) {
    last = { index: m.index }
    BLANK_LINE_ALL_RE.lastIndex = m.index + 1
  }
  return last
}

function isInlineOpenTag(part: string | undefined): boolean {
  if (!part) return false
  const m = part.match(/^<([a-z][\w:-]*)\b/i)
  return m != null && INLINE_FLOW_TAGS.has(m[1].toLowerCase())
}

export function processMarkdownInHtmlIsland(
  html: string,
  renderer: HtmlIslandMarkdownRenderer,
): string {
  const styleBlocks = new Map<string, string>()
  const chunks: string[] = []
  const styleOpen = /<style[\s>]/gi
  const styleClose = /<\/style\s*>/gi
  let cursor = 0
  let open: RegExpExecArray | null
  while ((open = styleOpen.exec(html)) !== null) {
    styleClose.lastIndex = styleOpen.lastIndex
    if (!styleClose.exec(html)) break
    const marker = '<!--ISLAND_STYLE_' + styleBlocks.size + '-->'
    chunks.push(html.slice(cursor, open.index), marker)
    cursor = styleClose.lastIndex
    styleBlocks.set(marker, html.slice(open.index, cursor))
    styleOpen.lastIndex = cursor
  }
  chunks.push(html.slice(cursor))
  const shielded = chunks.join('')
  const parts = shielded.split(/(<[^>]*>)/)
  const restoreStyle = (marker: string): string => {
    const style = styleBlocks.get(marker)
    if (style === undefined) return marker
    styleBlocks.delete(marker)
    return style
  }
  const restoreEmbeddedStyles = (part: string): string => styleBlocks.size > 0 && part.includes('<!--ISLAND_STYLE_')
    ? part.replace(/<!--ISLAND_STYLE_\d+-->/g, restoreStyle)
    : part
  const tagStack: TagStack = { tags: [], positions: new Map() }
  const rawTextState = { depth: 0 }
  const out: string[] = []

  // Paragraph grouping for islands whose root opts in via data-message-prose,
  // following markdown's line-based HTML-block rule: a block tag enters raw
  // HTML, the first blank line exits it, and only content outside raw HTML
  // groups into <p> paragraphs. Tag balance is deliberately ignored, matching
  // marked: card HTML with unclosed tags still gets its paragraphs.
  let group: string[] | null = null
  let groupHasText = false
  let messageWrapRoot = false
  let rawHtml = false

  const closeGroup = (): void => {
    if (!group) return
    if (groupHasText) {
      out.push('<p>', ...group, '</p>')
    } else {
      out.push(...group)
    }
    group = null
    groupHasText = false
  }

  const emit = (piece: string): void => {
    if (group) group.push(piece)
    else out.push(piece)
  }

  const handleBlockTextWithoutGroup = (text: string, nextPart: string | undefined): void => {
    if (!text.trim()) {
      out.push(text)
      return
    }
    if (isInlineOpenTag(nextPart) && messageWrapRoot) {
      // Trailing segment joins the upcoming inline tag as one paragraph. Its
      // leading blank line stays attached so pure-text fallback keeps its <p>.
      const lastBlank = findLastBlankLine(text)
      const head = lastBlank ? text.slice(0, lastBlank.index) : ''
      const tail = lastBlank ? text.slice(lastBlank.index) : text
      if (head.trim()) out.push(renderer.renderBlockText(head))
      else if (head) out.push(head)
      if (!tail.trim() && tail) out.push(tail)
      group = []
      groupHasText = false
      if (tail.trim()) {
        group.push(renderer.renderInlineText(tail))
        groupHasText = true
      }
      return
    }
    out.push(renderer.renderBlockText(text))
  }

  const handleBlockText = (text: string, nextPart: string | undefined): void => {
    if (!group) {
      handleBlockTextWithoutGroup(text, nextPart)
      return
    }
    const firstBlank = ISLAND_BLANK_LINE_RE.exec(text)
    if (!firstBlank) {
      if (text.trim()) {
        group.push(renderer.renderInlineText(text))
        groupHasText = true
      } else {
        group.push(text)
      }
      return
    }
    const head = text.slice(0, firstBlank.index)
    if (head.trim()) {
      group.push(renderer.renderInlineText(head))
      groupHasText = true
    } else if (head) {
      group.push(head)
    }
    closeGroup()
    const rest = text.slice(firstBlank.index)
    if (rest) handleBlockTextWithoutGroup(rest, nextPart)
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part) continue

    if (i % 2 === 1) {
      if (part.startsWith('<!--')) {
        if (STYLE_PLACEHOLDER_RE.test(part)) {
          closeGroup()
          out.push(styleBlocks.size > 0 ? restoreStyle(part) : part)
        } else {
          emit(restoreEmbeddedStyles(part))
        }
        continue
      }
      const nameMatch = part.match(/^<\/?([a-z][\w:-]*)\b/i)
      const name = nameMatch ? nameMatch[1].toLowerCase() : null
      if (tagStack.tags.length === 0 && !part.startsWith('</')) {
        messageWrapRoot = part.includes('data-message-prose')
      }
      if (name && SANITIZER_KEPT_TAGS.has(name) && !INLINE_FLOW_TAGS.has(name)) {
        closeGroup()
        out.push(restoreEmbeddedStyles(part))
        if (messageWrapRoot && tagStack.tags.length > 0) rawHtml = true
      } else {
        if (
          name !== null
          && INLINE_FLOW_TAGS.has(name)
          && !group
          && !part.startsWith('</')
          && messageWrapRoot
          && !rawHtml
          && rawTextState.depth === 0
          && !isMarkdownExcludedSubtree(tagStack)
        ) {
          group = []
          groupHasText = false
        }
        emit(restoreEmbeddedStyles(part))
      }
      updateTagStack(part, tagStack, rawTextState)
      continue
    }

    if (rawTextState.depth > 0 || isMarkdownExcludedSubtree(tagStack)) {
      emit(part)
      continue
    }
    if (STYLE_PLACEHOLDER_RE.test(part.trim())) {
      closeGroup()
      out.push(part)
      continue
    }
    if (messageWrapRoot) {
      if (rawHtml) {
        // Raw HTML runs to the first blank line, verbatim like CommonMark
        // type-6 blocks. The remainder re-enters document flow.
        const blank = ISLAND_BLANK_LINE_RE.exec(part)
        if (!blank) {
          out.push(part)
        } else {
          const head = part.slice(0, blank.index)
          if (head) out.push(head)
          rawHtml = false
          const rest = part.slice(blank.index)
          if (rest) handleBlockTextWithoutGroup(rest, parts[i + 1])
        }
      } else {
        handleBlockText(part, parts[i + 1])
      }
      continue
    }
    if (shouldRenderInlineMarkdown(tagStack)) {
      if (part.trim()) {
        emit(renderer.renderInlineText(part))
        if (group) groupHasText = true
      } else {
        emit(part)
      }
      continue
    }
    handleBlockText(part, parts[i + 1])
  }

  closeGroup()

  const result = out.join('')

  return renderer.normalizeHtml ? renderer.normalizeHtml(result) : result
}
