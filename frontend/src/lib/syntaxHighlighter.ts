function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const RULES = [
  { pattern: /(\{\{[^}]+\}\})/g, cls: 'lce-hl-macro' },
  { pattern: /(\{\{(?:user|char)\}\}\s*:)/g, cls: 'lce-hl-dialog' },
  { pattern: /(&lt;START&gt;|&lt;END&gt;|\[Start a new chat\])/gi, cls: 'lce-hl-marker' },
  { pattern: /(&lt;\/?[a-zA-Z][^&]*?&gt;)/g, cls: 'lce-hl-html' },
  { pattern: /^(#{1,6}\s.+)$/gm, cls: 'lce-hl-heading' },
  { pattern: /^(&gt;\s?.+)$/gm, cls: 'lce-hl-quote' },
  { pattern: /(\*\*[^*]+\*\*)/g, cls: 'lce-hl-bold' },
  { pattern: /(?<!\*)(\*(?!\*)[^*]+\*(?!\*))/g, cls: 'lce-hl-action' },
]

export function highlightContent(raw: string): string {
  if (!raw) return ''

  let text = escapeHtml(raw)
  const tokens: string[] = []

  function protect(match: string, cls: string): string {
    const idx = tokens.length
    tokens.push(`<span class="${cls}">${match}</span>`)
    return `\x00${idx}\x00`
  }

  for (const rule of RULES) {
    text = text.replace(rule.pattern, (m) => protect(m, rule.cls))
  }

  text = text.replace(/\x00(\d+)\x00/g, (_, idx) => tokens[parseInt(idx, 10)])

  return text
}
