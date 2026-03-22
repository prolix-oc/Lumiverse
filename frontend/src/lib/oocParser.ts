export interface OOCBlock {
  type: 'text' | 'ooc'
  content: string
  name?: string
}

// Matches <lumia_ooc>, <lumiao_ooc>, <lumiaooc>, <lumia_ooc name="X"> etc.
const OOC_TAG_RE = /<(lumi[ao]_?ooc)([^>]*)>([\s\S]*?)<\/\1>/gi

// Extracts name attribute from tag attributes string
const NAME_ATTR_RE = /name\s*=\s*(?:"([^"]*)"|'([^']*)'|&quot;([^&]*)&quot;|(\S+))/i

/**
 * Clean OOC content by stripping tag wrappers, font tags, and collapsing whitespace
 */
export function cleanOOCContent(html: string): string {
  if (!html) return ''

  let cleaned = html
  // Remove any nested lumia tags
  cleaned = cleaned.replace(/<\/?lumia_?[a-z_]*\s*>/gi, '')
  // Remove <font> tags (legacy extension format)
  cleaned = cleaned.replace(/<\/?font[^>]*>/gi, '')
  // Collapse multiple breaks/newlines
  cleaned = cleaned.replace(/(<br\s*\/?>\s*){2,}/gi, '<br>')
  cleaned = cleaned.replace(/(\n\s*){2,}/g, '\n')
  // Trim leading/trailing whitespace and breaks
  cleaned = cleaned.replace(/^(\s|<br\s*\/?>)+/gi, '')
  cleaned = cleaned.replace(/(\s|<br\s*\/?>)+$/gi, '')

  return cleaned.trim()
}

function extractName(attrs: string): string | undefined {
  const match = attrs.match(NAME_ATTR_RE)
  if (!match) return undefined
  return match[1] ?? match[2] ?? match[3] ?? match[4]
}

export function parseOOC(content: string): OOCBlock[] {
  if (!content) return []

  const blocks: OOCBlock[] = []
  let lastIndex = 0

  // Reset regex state
  OOC_TAG_RE.lastIndex = 0

  let match
  while ((match = OOC_TAG_RE.exec(content)) !== null) {
    const start = match.index
    const end = start + match[0].length
    const attrs = match[2]
    const rawContent = match[3]

    // Add preceding text block
    if (start > lastIndex) {
      blocks.push({ type: 'text', content: content.slice(lastIndex, start) })
    }

    const cleaned = cleanOOCContent(rawContent)
    if (cleaned) {
      blocks.push({
        type: 'ooc',
        content: cleaned,
        name: extractName(attrs),
      })
    }

    lastIndex = end
  }

  // Add trailing text
  if (lastIndex < content.length) {
    blocks.push({ type: 'text', content: content.slice(lastIndex) })
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'text', content })
  }

  return blocks
}
