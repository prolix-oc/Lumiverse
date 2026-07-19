const STYLE_PLACEHOLDER_RE = /^<!--ISLAND_STYLE_\d+-->$/
const VOID_HTML_TAG_RE = /^<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)\b/i
const RAW_TEXT_CONTEXT_TAGS = new Set(['code', 'pre', 'script'])
const NO_MARKDOWN_SUBTREE_TAGS = new Set(['svg'])

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

function updateTagStack(part: string, tagStack: string[], rawTextState: { depth: number }): void {
  const closeMatch = part.match(/^<\/([a-z][\w:-]*)\b/i)
  if (closeMatch) {
    const tag = closeMatch[1].toLowerCase()
    if (RAW_TEXT_CONTEXT_TAGS.has(tag)) rawTextState.depth = Math.max(0, rawTextState.depth - 1)
    const idx = tagStack.lastIndexOf(tag)
    if (idx >= 0) tagStack.splice(idx, 1)
    return
  }

  const openMatch = part.match(/^<([a-z][\w:-]*)\b/i)
  if (!openMatch) return

  const tag = openMatch[1].toLowerCase()
  if (RAW_TEXT_CONTEXT_TAGS.has(tag)) rawTextState.depth += 1

  const isSelfClosing = /\/\s*>$/.test(part) || VOID_HTML_TAG_RE.test(part)
  if (!isSelfClosing) tagStack.push(tag)
}

function shouldRenderInlineMarkdown(tagStack: string[]): boolean {
  const currentTag = tagStack[tagStack.length - 1]
  return currentTag != null && !BLOCK_MARKDOWN_PARENT_TAGS.has(currentTag)
}

function isMarkdownExcludedSubtree(tagStack: string[]): boolean {
  return tagStack.some((tag) => NO_MARKDOWN_SUBTREE_TAGS.has(tag))
}

export function processMarkdownInHtmlIsland(
  html: string,
  renderer: HtmlIslandMarkdownRenderer,
): string {
  const styleBlocks: string[] = []
  const shielded = html.replace(/<style[\s>][\s\S]*?<\/style\s*>/gi, (match) => {
    styleBlocks.push(match)
    return `<!--ISLAND_STYLE_${styleBlocks.length - 1}-->`
  })

  const parts = shielded.split(/(<[^>]*>)/)
  const tagStack: string[] = []
  const rawTextState = { depth: 0 }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]

    if (i % 2 === 1) {
      updateTagStack(part, tagStack, rawTextState)
      continue
    }

    if (!part.trim() || rawTextState.depth > 0 || isMarkdownExcludedSubtree(tagStack)) continue
    if (STYLE_PLACEHOLDER_RE.test(part.trim())) continue

    parts[i] = shouldRenderInlineMarkdown(tagStack)
      ? renderer.renderInlineText(part)
      : renderer.renderBlockText(part)
  }

  let result = parts.join('')
  for (let i = 0; i < styleBlocks.length; i++) {
    result = result.replace(`<!--ISLAND_STYLE_${i}-->`, styleBlocks[i])
  }

  return renderer.normalizeHtml ? renderer.normalizeHtml(result) : result
}
