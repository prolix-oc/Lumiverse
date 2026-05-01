import { useMemo, useRef, useLayoutEffect, useState, useEffect, useCallback, useSyncExternalStore, useDeferredValue } from 'react'
import { marked } from 'marked'
import { highlightCode } from '@/lib/codeHighlight'
import { parseOOC } from '@/lib/oocParser'
import { createEmphasisAwareRenderer } from '@/lib/markedEmphasisRenderer'
import { createStrictTildeTokenizer } from '@/lib/markedTokenizer'
import { healFormattingArtifacts } from '@/lib/formatHealing'
import { resolveDisplayMacros } from '@/lib/resolveDisplayMacros'
import { copyTextToClipboard } from '@/lib/clipboard'
import { sanitizeHtmlIsland, sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import {
  dispatchMessageTagIntercepts,
  stripMessageTags,
  subscribeTagInterceptorRegistry,
  getTagInterceptorRegistryVersion,
} from '@/lib/spindle/message-interceptors'
import { SpindleMessageWidgets } from '@/lib/spindle/message-widgets'
import { useStore } from '@/store'
import { useDisplayRegex } from '@/hooks/useDisplayRegex'
import { OOCBlock as OOCBlockComponent, OOCIrcChatRoom } from './ooc'
import type { IrcEntry } from './ooc'
import ImageLightbox from '@/components/shared/ImageLightbox'
import styles from './MessageContent.module.css'
import clsx from 'clsx'

interface MessageContentProps {
  content: string
  isUser: boolean
  userName: string
  isStreaming?: boolean
  lockStreamingHeight?: boolean
  messageId?: string
  chatId?: string
  depth?: number
}

// Custom renderer for sheld prose classes
const renderer = createEmphasisAwareRenderer({
  emClass: styles.proseItalic,
  strongClass: styles.proseBold,
  inlineEmphasisClass: styles.proseInlineEmphasis,
})

renderer.code = ({ text, lang }) => {
  if (lang) {
    const highlighted = highlightCode(text, lang)
    return `<div class="${styles.codeBlock}"><div class="${styles.codeHeader}"><span class="${styles.codeLang}">${escapeHtml(lang)}</span><button type="button" class="${styles.codeCopy}" data-code-copy title="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></div><pre><code class="hljs">${highlighted}</code></pre></div>`
  }
  // Fenced block with no lang — still render as block
  if (text.includes('\n')) {
    const highlighted = highlightCode(text)
    return `<div class="${styles.codeBlock}"><div class="${styles.codeHeader}"><span class="${styles.codeLang}">text</span><button type="button" class="${styles.codeCopy}" data-code-copy title="Copy code"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg><span>Copy</span></button></div><pre><code class="hljs">${highlighted}</code></pre></div>`
  }
  return `<code>${escapeHtml(text)}</code>`
}

renderer.link = function ({ href, title, tokens }) {
  const inner = this.parser.parseInline(tokens)
  return `<a href="${escapeHtml(href || '')}" target="_blank" rel="noopener noreferrer" class="${styles.proseLink}">${inner}</a>`
}

renderer.image = ({ href, title, text }) =>
  `<span class="${styles.proseImageWrap}"><img src="${escapeHtml(href || '')}" alt="${escapeHtml(text || '')}"${title ? ` title="${escapeHtml(title)}"` : ''} class="${styles.proseImage}" data-lightbox /></span>`

renderer.table = function (token) {
  const headerCells = token.header.map((cell) => this.tablecell(cell)).join('')
  const headerRow = this.tablerow({ text: headerCells })
  const bodyRows = token.rows.map((row) => {
    const cells = row.map((cell) => this.tablecell(cell)).join('')
    return this.tablerow({ text: cells })
  }).join('')
  return `<table class="${styles.proseTable}"><thead>${headerRow}</thead><tbody>${bodyRows}</tbody></table>`
}

renderer.tablerow = ({ text }) =>
  `<tr class="${styles.proseTableRow}">${text}</tr>`

renderer.tablecell = function (token) {
  const tag = token.header ? 'th' : 'td'
  const cls = token.header ? styles.proseTableHead : styles.proseTableCell
  const alignAttr = token.align ? ` style="text-align:${token.align}"` : ''
  const inner = this.parser.parseInline(token.tokens)
  return `<${tag} class="${cls}"${alignAttr}>${inner}</${tag}>`
}

renderer.html = ({ text }) => text

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeQuotes(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
}

function normalizeQuotesInHTML(html: string): string {
  return html
    .replace(/&ldquo;|&rdquo;|&bdquo;/g, '"')
    .replace(/&lsquo;|&rsquo;|&sbquo;/g, "'")
    .replace(/&laquo;|&raquo;/g, '"')
}

const BLOCK_CLOSE_RE = /^<\/(p|div|li|blockquote|h[1-6]|pre|table|tr|td|th)\b/i
const SKIP_OPEN_RE = /^<(pre|code)\b/i
const SKIP_CLOSE_RE = /^<\/(pre|code)\b/i

function colorizeDialogue(html: string): string {
  const parts = html.split(/(<[^>]*>)/)
  let result = ''
  let inQuote = false
  let skipDepth = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]

    if (i % 2 === 1) {
      if (SKIP_OPEN_RE.test(part)) skipDepth++
      else if (SKIP_CLOSE_RE.test(part)) skipDepth = Math.max(0, skipDepth - 1)

      if (inQuote && BLOCK_CLOSE_RE.test(part)) {
        result += '</span>'
        inQuote = false
      }
      result += part
      continue
    }

    if (skipDepth > 0 || !part) {
      result += part
      continue
    }

    let output = ''
    for (let j = 0; j < part.length; j++) {
      const isLiteral = part[j] === '"'
      const isEntity = !isLiteral
        && part[j] === '&'
        && part[j + 1] === 'q'
        && part[j + 2] === 'u'
        && part[j + 3] === 'o'
        && part[j + 4] === 't'
        && part[j + 5] === ';'

      if (isLiteral || isEntity) {
        if (!inQuote) {
          output += `<span class="${styles.proseDialogue}">&quot;`
          inQuote = true
        } else {
          output += '&quot;</span>'
          inQuote = false
        }
        if (isEntity) j += 5
      } else {
        output += part[j]
      }
    }
    result += output
  }

  if (inQuote) result += '</span>'

  return result
}

function addLazyLoadingToImages(html: string): string {
  return html.replace(/<img\b(?![^>]*\bloading=)/gi, '<img loading="lazy"')
}

function normalizeLegacyFontTags(html: string): string {
  return html
    .replace(/<font\b([^>]*)>/gi, (_match, attrs: string) => {
      const color = attrs.match(/\bcolor\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/i)?.slice(1).find(Boolean)
      const safeColor = color && /^[#\w\s(),.%+-]+$/.test(color) ? color : null

      return safeColor ? `<span style="color:${escapeHtml(safeColor)}">` : '<span>'
    })
    .replace(/<\/font\s*>/gi, '</span>')
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
}

function getMarkdownFence(line: string): MarkdownFence | null {
  const match = line.match(/^\s*(`{3,}|~{3,})/)
  if (!match) return null
  return {
    marker: match[1][0] as MarkdownFence['marker'],
    length: match[1].length,
  }
}

function isMarkdownFenceClose(line: string, fence: MarkdownFence): boolean {
  const trimmed = line.trimStart()
  const run = trimmed.match(/^(`+|~+)/)?.[0]
  if (!run) return false
  if (run[0] !== fence.marker || run.length < fence.length) return false
  return trimmed.slice(run.length).trim().length === 0
}

/**
 * Escape ordered-list patterns that don't form intentional multi-item lists.
 * Prevents lines like "25. She felt old" from rendering as <ol start="25">.
 * Only preserves list formatting when 2+ consecutive numbered lines exist
 * (bridging blank lines between them).
 */
function escapeIsolatedOrderedListItems(text: string): string {
  const lines = text.split('\n')
  const n = lines.length
  const LIST_RE = /^\s*\d+\.\s/

  // Track fenced code blocks to skip them
  let fenced = false
  const inFence: boolean[] = []
  for (let i = 0; i < n; i++) {
    if (/^\s*(`{3,}|~{3,})/.test(lines[i])) fenced = !fenced
    inFence[i] = fenced
  }

  const isCand = lines.map((l, i) => !inFence[i] && LIST_RE.test(l))

  // Group consecutive candidates, bridging only blank lines
  const isReal = new Array(n).fill(false)
  let i = 0
  while (i < n) {
    if (!isCand[i]) { i++; continue }

    const members = [i]
    let j = i + 1
    while (j < n) {
      if (isCand[j]) {
        members.push(j)
        j++
      } else if (lines[j].trim() === '') {
        let k = j
        while (k < n && lines[k].trim() === '') k++
        if (k < n && isCand[k]) {
          j = k
        } else {
          break
        }
      } else {
        break
      }
    }

    if (members.length >= 2) {
      for (const m of members) isReal[m] = true
    }

    i = j
  }

  return lines.map((line, idx) => {
    if (isCand[idx] && !isReal[idx]) {
      return line.replace(/^(\s*\d+)\.\s/, '$1\\. ')
    }
    return line
  }).join('\n')
}

function formatContent(raw: string): string {
  if (!raw) return ''
  const healed = healFormattingArtifacts(raw)
  const normalized = normalizeQuotes(healed)
  const listSafe = escapeIsolatedOrderedListItems(normalized)
  let html = marked.parse(listSafe, { async: false }) as string
  html = normalizeQuotesInHTML(html)
  html = normalizeLegacyFontTags(html)
  html = colorizeDialogue(html)
  html = addLazyLoadingToImages(html)
  return html
}

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
  silent: true,
  renderer,
  tokenizer: createStrictTildeTokenizer(),
})

// ── HTML Island Isolation ──
// Detects self-contained HTML blocks containing <style> tags or significant
// inline styling and extracts them for Shadow DOM rendering, preventing markdown
// parsing from breaking interactive/styled HTML (CSS checkbox/radio hacks, tabs,
// phone screens, etc.) and isolating their styles.

const HTML_ISLAND_TOKEN = 'LUMIVERSE_HTML_ISLAND'
const ISLAND_RE = new RegExp(`<!--${HTML_ISLAND_TOKEN}_(\\d+)-->`, 'g')
const INLINE_STYLE_ATTR_RE = /\bstyle\s*=/gi
const NO_ISLAND_ATTR_RE = /\bdata-no-island\b/i
const ROOT_HTML_TAG_RE = /^<([a-z][\w:-]*)\b[^>]*>/i
const VOID_HTML_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const ISLAND_BASE_CSS = `
  :host {
    display: block;
    font-size: calc(14px * var(--lumiverse-font-scale, 1));
    line-height: 1.65;
    color: var(--lumiverse-text);
    word-wrap: break-word;
    overflow-wrap: break-word;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  q {
    quotes: none;
  }

  q::before,
  q::after {
    content: none;
  }

  p {
    margin: 0 0 0.5em;
  }

  p:last-child {
    margin-bottom: 0;
  }

  em,
  .${styles.proseItalic} {
    color: var(--lumiverse-prose-italic);
    font-style: italic;
  }

  strong,
  .${styles.proseBold} {
    font-weight: 600;
    color: var(--lumiverse-prose-bold);
  }

  .${styles.proseInlineEmphasis} {
    font-weight: 600;
    color: var(--lumiverse-prose-bold);
  }

  .${styles.proseDialogue} {
    color: var(--lumiverse-prose-dialogue);
  }

  span[style*="color"] .${styles.proseDialogue},
  span[style*="color"] em,
  span[style*="color"] .${styles.proseItalic},
  span[style*="color"] strong,
  span[style*="color"] .${styles.proseBold},
  span[style*="color"] .${styles.proseInlineEmphasis},
  font .${styles.proseDialogue},
  font em,
  font .${styles.proseItalic},
  font strong,
  font .${styles.proseBold},
  font .${styles.proseInlineEmphasis} {
    color: inherit;
  }

  .${styles.proseDialogue} em,
  .${styles.proseDialogue} .${styles.proseItalic},
  .${styles.proseDialogue} strong,
  .${styles.proseDialogue} .${styles.proseBold},
  .${styles.proseDialogue} .${styles.proseInlineEmphasis} {
    color: inherit;
  }

  code {
    padding: 2px 6px;
    border-radius: 4px;
    background: var(--lumiverse-fill-subtle);
    border: 1px solid var(--lcs-glass-border);
    font-family: "SF Mono", "Fira Code", "JetBrains Mono", "Menlo", "Consolas", monospace;
    font-size: 0.88em;
    color: var(--lumiverse-primary-text);
  }

  .${styles.codeBlock} {
    position: relative;
    margin: 10px 0;
    border-radius: 10px;
    overflow: hidden;
    background: var(--lumiverse-fill-strong);
    border: 1px solid var(--lumiverse-border);
  }

  .${styles.codeHeader} {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 14px;
    background: var(--lumiverse-fill-subtle);
    border-bottom: 1px solid var(--lumiverse-border);
  }

  .${styles.codeLang} {
    font-family: "SF Mono", "Fira Code", "JetBrains Mono", "Menlo", "Consolas", monospace;
    font-size: 0.72em;
    font-weight: 500;
    color: var(--lumiverse-text-dim);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    user-select: none;
  }

  .${styles.codeCopy} {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 8px;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: var(--lumiverse-text-dim);
    font-family: inherit;
    font-size: 0.72em;
    cursor: pointer;
    opacity: 0;
    transition: opacity 150ms ease, color 150ms ease, background 150ms ease;
  }

  .${styles.codeBlock}:hover .${styles.codeCopy} {
    opacity: 1;
  }

  .${styles.codeCopy}:hover {
    color: var(--lumiverse-text);
    background: var(--lumiverse-fill-subtle);
  }

  .${styles.codeCopied} {
    opacity: 1 !important;
    color: var(--lumiverse-success, #4ade80) !important;
  }

  .${styles.codeBlock} pre {
    margin: 0;
    padding: 14px;
    overflow-x: auto;
    white-space: pre;
  }

  .${styles.codeBlock} pre code {
    font-family: "SF Mono", "Fira Code", "JetBrains Mono", "Menlo", "Consolas", monospace;
    font-size: 0.85em;
    line-height: 1.6;
    color: var(--lumiverse-text);
    background: none;
    padding: 0;
    border: none;
    border-radius: 0;
    tab-size: 2;
  }

  pre {
    padding: 14px;
    border-radius: 10px;
    background: var(--lumiverse-fill-strong);
    border: 1px solid var(--lumiverse-border);
    overflow-x: auto;
    margin: 10px 0;
    white-space: pre-wrap;
    word-wrap: break-word;
  }

  pre code {
    padding: 0;
    background: none;
    border: none;
    font-size: 0.85em;
    line-height: 1.6;
    color: var(--lumiverse-text);
    white-space: pre-wrap;
  }

  blockquote {
    border-left: 2px solid var(--lumiverse-primary-020);
    padding-left: 12px;
    margin: 8px 0;
    background: var(--lumiverse-primary-010);
    border-radius: 0 var(--lcs-radius-xs) var(--lcs-radius-xs) 0;
    padding: 6px 12px;
    color: var(--lumiverse-prose-blockquote);
    font-style: italic;
  }

  h1 { font-size: 1.35em; font-weight: 600; margin: 0.7em 0 0.35em; }
  h2 { font-size: 1.2em; font-weight: 600; margin: 0.7em 0 0.35em; }
  h3 { font-size: 1.1em; font-weight: 600; margin: 0.7em 0 0.35em; }
  h4 { font-size: 1em; font-weight: 600; margin: 0.7em 0 0.35em; }
  h5 { font-size: 0.95em; font-weight: 600; margin: 0.7em 0 0.35em; }
  h6 { font-size: 0.9em; font-weight: 600; margin: 0.7em 0 0.35em; }

  hr {
    border: none;
    border-top: 1px solid var(--lumiverse-border);
    margin: 12px 0;
  }

  ul,
  ol {
    padding-left: 1.4em;
    margin: 4px 0;
    list-style-position: outside;
  }

  li {
    margin: 2px 0;
  }

  ul li {
    list-style: disc;
  }

  ol li {
    list-style: decimal;
  }

  a,
  .${styles.proseLink} {
    color: var(--lumiverse-prose-link, var(--lumiverse-primary-text));
    text-decoration: none;
    transition: color var(--lumiverse-transition-fast), text-decoration var(--lumiverse-transition-fast);
  }

  a:hover,
  .${styles.proseLink}:hover {
    text-decoration: underline;
    filter: brightness(1.15);
  }

  .${styles.proseImageWrap} {
    display: inline-block;
    margin: 8px 0;
    max-width: var(--prose-image-max-width, 240px);
    max-height: var(--prose-image-max-height, 240px);
    overflow: hidden;
    border-radius: var(--lcs-radius-sm);
    border: 1px solid var(--lumiverse-border, rgba(255, 255, 255, 0.1));
    background: var(--lumiverse-fill-subtle, rgba(255, 255, 255, 0.04));
    cursor: pointer;
    transition: border-color var(--lumiverse-transition-fast), box-shadow var(--lumiverse-transition-fast), transform var(--lumiverse-transition-fast);
  }

  .${styles.proseImageWrap}:hover {
    border-color: var(--lumiverse-primary-040, rgba(140, 130, 255, 0.4));
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
    transform: scale(1.02);
  }

  .${styles.proseImage},
  img {
    display: block;
    max-width: 100%;
    max-height: var(--prose-image-max-height, 240px);
    object-fit: contain;
    border-radius: var(--lcs-radius-sm);
    cursor: pointer;
  }

  .${styles.proseTable},
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 8px 0;
    border: 1px solid var(--lumiverse-border);
    border-radius: var(--lcs-radius-xs);
    overflow: hidden;
  }

  .${styles.proseTableHead},
  th {
    font-weight: 600;
    background: var(--lumiverse-primary-010);
    border: 1px solid var(--lumiverse-border);
    padding: 8px 12px;
    text-align: left;
    font-size: calc(13px * var(--lumiverse-font-scale, 1));
  }

  .${styles.proseTableCell},
  td {
    padding: 8px 12px;
    border: 1px solid var(--lumiverse-border);
    font-size: calc(13px * var(--lumiverse-font-scale, 1));
  }

  .${styles.proseTableRow}:nth-child(even) td,
  tr:nth-child(even) td {
    background: var(--lumiverse-bg-dark);
  }

  video,
  audio {
    max-width: 100%;
    border-radius: var(--lcs-radius-sm);
    margin: 8px 0;
  }

  iframe {
    max-width: 100%;
    max-height: 400px;
    border-radius: var(--lcs-radius-sm);
    border: 1px solid var(--lumiverse-border);
    margin: 8px 0;
  }

  .spindle-message-tag-pending {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    padding: 7px 10px;
    border: 1px solid color-mix(in srgb, var(--lumiverse-primary, #8c82ff) 22%, var(--lumiverse-border));
    border-radius: 999px;
    background: color-mix(in srgb, var(--lumiverse-primary, #8c82ff) 8%, transparent);
    color: var(--lumiverse-text-muted);
    font-size: calc(12px * var(--lumiverse-font-scale, 1));
    line-height: 1.2;
    letter-spacing: 0.01em;
  }

  .spindle-message-tag-pending-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: var(--lumiverse-primary, #8c82ff);
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--lumiverse-primary, #8c82ff) 45%, transparent);
    animation: spindle-message-tag-pending-pulse 1.25s ease-in-out infinite;
  }

  @keyframes spindle-message-tag-pending-pulse {
    0%,
    100% {
      opacity: 0.45;
      transform: scale(0.9);
      box-shadow: 0 0 0 0 color-mix(in srgb, var(--lumiverse-primary, #8c82ff) 30%, transparent);
    }

    50% {
      opacity: 1;
      transform: scale(1);
      box-shadow: 0 0 0 5px transparent;
    }
  }
`

/** Detect HTML blocks with enough inline styling to warrant island extraction. */
function hasSignificantInlineStyles(html: string): boolean {
  INLINE_STYLE_ATTR_RE.lastIndex = 0
  let count = 0
  while (INLINE_STYLE_ATTR_RE.exec(html)) {
    if (++count >= 3) return true
  }
  return false
}

function hasBalancedStyleTags(html: string): boolean {
  const opens = (html.match(/<style[\s>]/gi) || []).length
  const closes = (html.match(/<\/style\s*>/gi) || []).length
  return opens === closes
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function getHtmlRootTag(line: string): { tag: string; isVoid: boolean } | null {
  const match = line.match(ROOT_HTML_TAG_RE)
  if (!match) return null

  const tag = match[1].toLowerCase()
  return {
    tag,
    isVoid: VOID_HTML_TAGS.has(tag) || /\/\s*>$/.test(match[0]),
  }
}

function countTagDepthDelta(line: string, tag: string): number {
  const matches = line.matchAll(new RegExp(`<\\/?${escapeRegexLiteral(tag)}\\b[^>]*>`, 'gi'))
  let delta = 0

  for (const match of matches) {
    const token = match[0]
    if (/^<\//.test(token)) delta -= 1
    else if (!/\/\s*>$/.test(token) && !VOID_HTML_TAGS.has(tag)) delta += 1
  }

  return delta
}

function renderIslandMarkdownText(markdown: string): string {
  const leadingWhitespace = markdown.match(/^\s*/)?.[0] ?? ''
  const trailingWhitespace = markdown.match(/\s*$/)?.[0] ?? ''
  const core = markdown.trim()

  if (!core) return markdown

  let html = marked.parse(core, { async: false }) as string
  html = normalizeQuotesInHTML(html)

  const singleParagraphMatch = html.match(/^<p>([\s\S]*)<\/p>\s*$/)
  if (singleParagraphMatch && !/<\/p>\s*<p\b/i.test(html)) {
    html = singleParagraphMatch[1]
  }

  return `${leadingWhitespace}${html}${trailingWhitespace}`
}

function extractHtmlIslands(
  raw: string,
  isStreaming: boolean,
): { content: string; islands: string[] } {
  const hasStyleTag = /<style[\s>]/i.test(raw)
  if (!hasStyleTag && !/\bstyle\s*=/i.test(raw)) return { content: raw, islands: [] }

  const trimmedRaw = raw.trim()
  if (
    /^(?:<!doctype\b|<html\b|<head\b)/i.test(trimmedRaw)
    && /<\/(?:html|body|head)>$/i.test(trimmedRaw)
  ) {
    return { content: `<!--${HTML_ISLAND_TOKEN}_0-->`, islands: [raw] }
  }

  const islands: string[] = []
  const lines = raw.split('\n')
  const output: string[] = []
  let i = 0

  while (i < lines.length) {
    const trimmed = lines[i].trim()

    // Fenced markdown code blocks are literal content and must not be scanned
    // for extractable HTML islands.
    const fence = getMarkdownFence(lines[i])
    if (fence) {
      output.push(lines[i])
      i++

      while (i < lines.length) {
        output.push(lines[i])
        if (isMarkdownFenceClose(lines[i], fence)) {
          i++
          break
        }
        i++
      }
      continue
    }

    // Strategy 1: Block-level element or full HTML document that might wrap a
    // <style> block or contain significant inline styling (e.g. phone screens,
    // UI mockups).
    // Collect the entire balanced tag tree, then check for isolation criteria.
    const rootTag = getHtmlRootTag(trimmed)
    if (rootTag) {
      const blockLines: string[] = []
      const { tag, isVoid } = rootTag
      let depth = 0

      while (i < lines.length) {
        const line = lines[i]
        blockLines.push(line)
        i++
        if (!isVoid) depth += countTagDepthDelta(line, tag)
        if (depth <= 0) break
        if (isVoid) break
      }

      const blockContent = blockLines.join('\n')

      const openingTagEnd = blockContent.indexOf('>')
      const openingTag = openingTagEnd >= 0 ? blockContent.slice(0, openingTagEnd) : blockContent
      if (NO_ISLAND_ATTR_RE.test(openingTag)) {
        output.push(...blockLines)
        continue
      }

      const isIslandCandidate = /<style[\s>]/i.test(blockContent) || hasSignificantInlineStyles(blockContent)
      const canRenderStreamingPreview = isStreaming && !isVoid && hasBalancedStyleTags(blockContent)

      // While a styled HTML wrapper is still streaming, keep it inside a Shadow DOM
      // island as soon as its internal <style> tags are balanced. That preserves the
      // authored presentation instead of falling back to prose sanitization until the
      // outer wrapper finally closes.
      if (isIslandCandidate && (depth <= 0 || canRenderStreamingPreview)) {
        const idx = islands.length
        islands.push(blockContent)
        output.push('', `<!--${HTML_ISLAND_TOKEN}_${idx}-->`, '')
      } else {
        // Not an island — pass through for normal markdown processing
        output.push(...blockLines)
      }
      continue
    }

    // Strategy 2: Standalone <style> block not inside a wrapper element.
    // Collect the style block + any subsequent sibling HTML.
    if (/^\s*<style[\s>]/i.test(trimmed)) {
      const buf: string[] = []

      while (i < lines.length) {
        buf.push(lines[i])
        if (/<\/style\s*>/i.test(lines[i])) { i++; break }
        i++
      }

      // During streaming, don't extract an incomplete <style> block as an island.
      // Let it fall through to prose sanitization until the closing tag arrives.
      const styleBlock = buf.join('\n')
      if (isStreaming && !hasBalancedStyleTags(styleBlock)) {
        output.push(...buf)
        continue
      }

      let depth = 0
      let blanks = 0
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t) {
          blanks++
          if (depth <= 0 && blanks >= 2) break
          buf.push(lines[i])
          i++
          continue
        }
        blanks = 0

        const oCount = (t.match(/<(?:div|section|form|details|article|aside|nav|fieldset|figure|main|header|footer|table|ul|ol|dl|html|head|body)\b/gi) || []).length
        const cCount = (t.match(/<\/(?:div|section|form|details|article|aside|nav|fieldset|figure|main|header|footer|table|ul|ol|dl|html|head|body)\b/gi) || []).length
        depth += oCount - cCount

        if (/^<[a-zA-Z\/!]/.test(t) || depth > 0) {
          buf.push(lines[i])
          i++
          if (depth <= 0) {
            let p = i
            while (p < lines.length && !lines[p].trim()) p++
            if (p >= lines.length || !/^<[a-zA-Z\/!]/.test(lines[p].trim())) break
          }
        } else {
          break
        }
      }

      while (buf.length && !buf[buf.length - 1].trim()) buf.pop()

      const idx = islands.length
      islands.push(buf.join('\n'))
      output.push('', `<!--${HTML_ISLAND_TOKEN}_${idx}-->`, '')
      continue
    }

    output.push(lines[i])
    i++
  }

  return { content: output.join('\n'), islands }
}

/**
 * Convert markdown within HTML island text content to rendered HTML.
 * Preserves <style> blocks and HTML tag structure while running text nodes
 * through the full markdown parser, then unwraps single-paragraph results so
 * inline content inside HTML tags stays inline in Shadow DOM.
 */
function processMarkdownInIsland(html: string): string {
  // Protect <style> blocks — CSS selectors can contain '>' which breaks tag splitting
  const styleBlocks: string[] = []
  const shielded = html.replace(/<style[\s>][\s\S]*?<\/style\s*>/gi, (m) => {
    styleBlocks.push(m)
    return `<!--ISLAND_STYLE_${styleBlocks.length - 1}-->`
  })

  // Split into HTML tags (odd indices) and text content (even indices)
  const parts = shielded.split(/(<[^>]*>)/)
  let skipDepth = 0

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]

    // HTML tags — track elements whose content should not be processed
    if (i % 2 === 1) {
      if (/^<(pre|code|script)\b/i.test(part)) skipDepth++
      else if (/^<\/(pre|code|script)\b/i.test(part)) skipDepth = Math.max(0, skipDepth - 1)
      continue
    }

    // Text content — skip if empty, inside skip element, or a style placeholder
    if (!part.trim() || skipDepth > 0) continue
    if (/^<!--ISLAND_STYLE_\d+-->$/.test(part.trim())) continue

    parts[i] = renderIslandMarkdownText(part)
  }

  let result = parts.join('')

  // Restore <style> blocks
  for (let i = 0; i < styleBlocks.length; i++) {
    result = result.replace(`<!--ISLAND_STYLE_${i}-->`, styleBlocks[i])
  }

  return normalizeLegacyFontTags(result)
}

interface ContentPiece {
  type: 'markup' | 'island'
  content: string
}

function formatContentPieces(raw: string, isStreaming: boolean): ContentPiece[] {
  if (!raw) return []

  const { content, islands } = extractHtmlIslands(raw, isStreaming)

  if (islands.length === 0) {
    return [{ type: 'markup', content: sanitizeRichHtml(formatContent(raw)) }]
  }

  const html = formatContent(content)
  const pieces: ContentPiece[] = []
  let lastIdx = 0

  for (const m of html.matchAll(ISLAND_RE)) {
    const before = html.slice(lastIdx, m.index!)
    if (before.trim()) pieces.push({ type: 'markup', content: sanitizeRichHtml(before) })
    const idx = parseInt(m[1], 10)
    if (islands[idx] != null) {
      pieces.push({ type: 'island', content: sanitizeHtmlIsland(processMarkdownInIsland(islands[idx])) })
    }
    lastIdx = m.index! + m[0].length
  }

  const after = html.slice(lastIdx)
  if (after.trim()) pieces.push({ type: 'markup', content: sanitizeRichHtml(after) })

  return pieces
}

function attachCodeCopyHandler(root: HTMLElement | ShadowRoot): () => void {
  const handleClick = (e: MouseEvent) => {
    const target = e.target
    if (!(target instanceof Element)) return

    const btn = target.closest('[data-code-copy]') as HTMLButtonElement | null
    if (!btn) return

    const codeBlock = btn.closest(`.${styles.codeBlock}`)
    const codeEl = codeBlock?.querySelector('code')
    if (!codeEl) return

    const text = codeEl.textContent || ''
    copyTextToClipboard(text).then(() => {
      const label = btn.querySelector('span')
      if (label) {
        label.textContent = 'Copied!'
        btn.classList.add(styles.codeCopied)
        setTimeout(() => {
          label.textContent = 'Copy'
          btn.classList.remove(styles.codeCopied)
        }, 2000)
      }
    }).catch((err) => {
      console.error('[MessageContent] Copy failed:', err)
    })
  }

  root.addEventListener('click', handleClick)
  return () => root.removeEventListener('click', handleClick)
}

function IsolatedHtml({ html }: { html: string }) {
  const ref = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const shadow = el.shadowRoot ?? el.attachShadow({ mode: 'open' })
    shadow.innerHTML = `<style>${ISLAND_BASE_CSS}</style>${html}`
    return attachCodeCopyHandler(shadow)
  }, [html])

  return <div ref={ref} className={styles.htmlIsland} />
}

/**
 * dangerouslySetInnerHTML wrapper that preserves IMG element identity by
 * src across innerHTML replacements, so images don't redo the cache lookup,
 * decode, paint cycle on every chat re-render.
 */
function ProseHtml({ html, className }: { html: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const lastHtmlRef = useRef<string | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (lastHtmlRef.current === html) return

    const stableImgs = new Map<string, HTMLImageElement>()
    if (lastHtmlRef.current !== null) {
      for (const img of el.querySelectorAll<HTMLImageElement>('img[src]')) {
        const src = img.getAttribute('src')
        if (src && !stableImgs.has(src)) stableImgs.set(src, img)
      }
    }

    el.innerHTML = html
    lastHtmlRef.current = html

    if (stableImgs.size === 0) return
    for (const newImg of el.querySelectorAll<HTMLImageElement>('img[src]')) {
      const src = newImg.getAttribute('src')
      if (!src) continue
      const preserved = stableImgs.get(src)
      if (preserved && newImg.parentNode) {
        newImg.replaceWith(preserved)
        stableImgs.delete(src)
      }
    }
  }, [html])

  return <div ref={ref} className={className} />
}

// Risu <img="AssetName"> tag pattern — resolved at display time using character's asset map
const RISU_IMG_TAG_RE = /<img="([^"]+)">/gi

// Standard <img src="AssetName"> where src is a relative asset reference (not a URL)
const IMG_SRC_ASSET_RE = /<img\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>/gi

// Markdown ![alt](src) where src is a relative asset reference (not a URL)
const MARKDOWN_IMG_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

/** Strip path prefix and file extension to get the asset stem. */
function assetStem(name: string): string {
  const base = name.split('/').pop() || name
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

/** Look up an asset reference in the map — tries exact, then stem. Handles embeded:// URIs. */
function resolveAssetId(src: string, assetMap: Record<string, string>): string | undefined {
  // Strip Risu embeded:// prefix
  const cleaned = src.startsWith('embeded://') ? src.slice('embeded://'.length) : src
  return assetMap[cleaned] ?? assetMap[assetStem(cleaned)]
}

/** Resolve Risu <img="AssetName"> tags to rendered image markdown using the character's stored asset map. */
function resolveRisuAssetTags(text: string, assetMap: Record<string, string>): string {
  if (!text.includes('<img="')) return text
  RISU_IMG_TAG_RE.lastIndex = 0
  return text.replace(RISU_IMG_TAG_RE, (match, assetName: string) => {
    const imageId = resolveAssetId(assetName, assetMap)
    if (imageId) return `\n\n![${assetName.replace(/[[\]]/g, '')}](/api/v1/images/${imageId})\n\n`
    return match
  })
}

/** Resolve standard <img src="AssetName"> tags where src is an unresolved asset reference.
 *  Unresolved asset refs are converted to markdown images so they go through the same
 *  custom renderer (proseImageWrap, lightbox) as Risu <img="..."> tags.
 *  Already-resolved URLs (absolute paths, http, data:) are left as raw HTML. */
function resolveImgSrcAssetTags(text: string, assetMap: Record<string, string>): string {
  IMG_SRC_ASSET_RE.lastIndex = 0
  return text.replace(IMG_SRC_ASSET_RE, (match, before: string, src: string, after: string) => {
    // Skip already-resolved URLs — these are valid img tags that should render as-is
    if (/^(?:https?:\/\/|\/|data:)/i.test(src)) return match
    const imageId = resolveAssetId(src, assetMap)
    if (imageId) {
      const alt = src.replace(/[[\]]/g, '')
      return `\n\n![${alt}](/api/v1/images/${imageId})\n\n`
    }
    return match
  })
}

/** Resolve markdown ![alt](src) images where src is an unresolved asset reference.
 *  Handles the common AI-generated pattern of referencing Risu assets by relative
 *  filename (including extensions like .webp/.png/.jpg). Already-resolved URLs are
 *  left as-is. Strips a trailing markdown title ("...") before lookup. */
function resolveMarkdownImgTags(text: string, assetMap: Record<string, string>): string {
  if (!text.includes('![')) return text
  MARKDOWN_IMG_RE.lastIndex = 0
  return text.replace(MARKDOWN_IMG_RE, (match, alt: string, rawSrc: string) => {
    // Strip trailing markdown title: ![alt](src "title") → src
    const src = rawSrc.trim().replace(/\s+["'][^"']*["']\s*$/, '').trim()
    if (!src) return match
    if (/^(?:https?:\/\/|\/|data:)/i.test(src)) return match
    const imageId = resolveAssetId(src, assetMap)
    if (imageId) return `![${alt}](/api/v1/images/${imageId})`
    return match
  })
}

export default function MessageContent({
  content,
  isUser,
  userName,
  isStreaming = false,
  lockStreamingHeight = true,
  messageId,
  chatId,
  depth = 0,
}: MessageContentProps) {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)

  const charName = useMemo(
    () => characters.find((c) => c.id === activeCharacterId)?.name ?? 'Assistant',
    [characters, activeCharacterId],
  )

  // Merge Risu asset maps from active character (and all group members in group chats)
  const risuAssetMap = useMemo(() => {
    const charIds = isGroupChat && groupCharacterIds.length > 0
      ? groupCharacterIds
      : activeCharacterId ? [activeCharacterId] : []
    let merged: Record<string, string> | null = null
    for (const id of charIds) {
      const map = characters.find((c) => c.id === id)?.extensions?.risu_asset_map
      if (map && typeof map === 'object') {
        if (!merged) merged = { ...map }
        else Object.assign(merged, map)
      }
    }
    return merged
  }, [characters, activeCharacterId, isGroupChat, groupCharacterIds])

  const interceptorRegistryVersion = useSyncExternalStore(
    subscribeTagInterceptorRegistry,
    getTagInterceptorRegistryVersion,
    getTagInterceptorRegistryVersion,
  )
  const interceptedMessageTags = useMemo(
    () => stripMessageTags(content, { messageId, chatId, isUser, isStreaming }),
    [content, messageId, chatId, isUser, isStreaming, interceptorRegistryVersion],
  )

  useLayoutEffect(() => {
    dispatchMessageTagIntercepts(interceptedMessageTags.intercepts)
  }, [interceptedMessageTags.intercepts])

  const interceptorCleanedContent = interceptedMessageTags.content

  // Resolve Risu asset tags before regex/macro processing:
  // 1. <img="AssetName"> (Risu custom syntax) → markdown image
  // 2. <img src="AssetName"> (standard HTML with relative asset ref) → resolved src URL
  // 3. ![alt](AssetName.ext) (markdown image with relative asset ref) → resolved src URL
  const risuResolvedContent = useMemo(
    () => {
      if (!risuAssetMap) return interceptorCleanedContent
      let resolved = resolveRisuAssetTags(interceptorCleanedContent, risuAssetMap)
      resolved = resolveImgSrcAssetTags(resolved, risuAssetMap)
      resolved = resolveMarkdownImgTags(resolved, risuAssetMap)
      return resolved
    },
    [interceptorCleanedContent, risuAssetMap],
  )

  const macroCtx = useMemo(() => ({ charName, userName }), [charName, userName])
  const regexAppliedContent = useDisplayRegex(risuResolvedContent, isUser, depth, macroCtx)
  const resolvedContent = useMemo(
    () => resolveDisplayMacros(regexAppliedContent, { charName, userName }),
    [regexAppliedContent, charName, userName],
  )
  const deferredResolvedContent = useDeferredValue(resolvedContent)
  const renderContent = isStreaming ? deferredResolvedContent : resolvedContent
  const blocks = useMemo(() => parseOOC(renderContent), [renderContent])
  const oocEnabled = useStore((s) => s.oocEnabled)
  const lumiaOOCStyle = useStore((s) => s.lumiaOOCStyle)
  const containerRef = useRef<HTMLDivElement>(null)
  const prevTextLenRef = useRef(0)
  const maxStreamingHeightRef = useRef(0)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [streamingMinHeight, setStreamingMinHeight] = useState<number | null>(null)

  const handleLightboxClose = useCallback(() => setLightboxSrc(null), [])

  // Attach click handler for images with data-lightbox
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const handleClick = (e: MouseEvent) => {
      const img = (e.target as HTMLElement).closest('img[data-lightbox], .prose img') as HTMLImageElement | null
      if (img?.src) setLightboxSrc(img.src)
    }
    container.addEventListener('click', handleClick)
    return () => container.removeEventListener('click', handleClick)
  }, [])

  // Attach click handler for code copy buttons
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return attachCodeCopyHandler(container)
  }, [])

  useLayoutEffect(() => {
    if (!isStreaming || !lockStreamingHeight) {
      maxStreamingHeightRef.current = 0
      setStreamingMinHeight(null)
      return
    }

    const container = containerRef.current
    if (!container) return

    const updateMinHeight = () => {
      const nextHeight = Math.ceil(container.getBoundingClientRect().height)
      if (nextHeight <= maxStreamingHeightRef.current) return
      maxStreamingHeightRef.current = nextHeight
      setStreamingMinHeight(nextHeight)
    }

    updateMinHeight()

    const observer = new ResizeObserver(() => {
      updateMinHeight()
    })

    observer.observe(container)
    return () => observer.disconnect()
  }, [isStreaming, lockStreamingHeight])

  const renderedBlocks = useMemo(() => {
    const elements: React.ReactNode[] = []
    let oocIndex = 0

    // For IRC mode, gather ALL OOC blocks into one grouped chat room
    // rendered at the position of the last OOC block
    if (lumiaOOCStyle === 'irc' && oocEnabled) {
      const allIrcEntries: IrcEntry[] = []
      let lastOocIndex = -1

      // First pass: collect all OOC entries and find last OOC position
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].type === 'ooc') {
          allIrcEntries.push({ name: blocks[i].name || '', content: blocks[i].content })
          lastOocIndex = i
        }
      }

      // Second pass: render text blocks normally, insert grouped chat room at last OOC position
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (block.type === 'ooc') {
          // Render the grouped chat room after the last OOC block
          if (i === lastOocIndex && allIrcEntries.length > 0) {
            elements.push(
              <OOCIrcChatRoom key={`irc-${i}`} entries={allIrcEntries} />
            )
          }
          // Otherwise skip — OOC content is hidden until rendered in the grouped box
        } else {
          const pieces = formatContentPieces(block.content, isStreaming)
          for (let p = 0; p < pieces.length; p++) {
            const piece = pieces[p]
            elements.push(
              piece.type === 'island'
                ? <IsolatedHtml key={`${i}-island-${p}`} html={piece.content} />
                : <ProseHtml key={`${i}-${p}`} className={styles.prose} html={piece.content} />
            )
          }
        }
      }
    } else {
      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]
        if (block.type === 'ooc') {
          if (!oocEnabled) continue
          elements.push(
            <OOCBlockComponent key={i} content={block.content} name={block.name} index={oocIndex} />
          )
          oocIndex++
        } else {
          const pieces = formatContentPieces(block.content, isStreaming)
          for (let p = 0; p < pieces.length; p++) {
            const piece = pieces[p]
            elements.push(
              piece.type === 'island'
                ? <IsolatedHtml key={`${i}-island-${p}`} html={piece.content} />
                : <ProseHtml key={`${i}-${p}`} className={styles.prose} html={piece.content} />
            )
          }
        }
      }
    }

    return elements
  }, [blocks, oocEnabled, lumiaOOCStyle, isStreaming])

  // Chunk fade animation for streaming tokens
  useLayoutEffect(() => {
    if (!isStreaming || !containerRef.current) {
      prevTextLenRef.current = content.length
      return
    }

    const container = containerRef.current
    const currentLen = content.length
    const prevLen = prevTextLenRef.current

    if (currentLen <= prevLen) {
      prevTextLenRef.current = currentLen
      return
    }

    // Walk text nodes and wrap new content
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    let charCount = 0
    const nodesToWrap: { node: Text; start: number; end: number }[] = []

    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text
      const nodeLen = textNode.length
      const nodeStart = charCount
      const nodeEnd = charCount + nodeLen

      if (nodeEnd > prevLen) {
        const start = Math.max(0, prevLen - nodeStart)
        nodesToWrap.push({ node: textNode, start, end: nodeLen })
      }

      charCount += nodeLen
    }

    for (const { node, start, end } of nodesToWrap) {
      if (start === 0 && end === node.length) {
        // Wrap entire node
        const span = document.createElement('span')
        span.className = styles.chunkFade
        node.parentNode?.insertBefore(span, node)
        span.appendChild(node)
      } else if (start < end) {
        // Split and wrap only new portion
        const newPart = node.splitText(start)
        const span = document.createElement('span')
        span.className = styles.chunkFade
        newPart.parentNode?.insertBefore(span, newPart)
        span.appendChild(newPart)
      }
    }

    prevTextLenRef.current = currentLen
  }, [content, isStreaming])

  return (
    <>
      <div
        data-component="MessageContent"
        ref={containerRef}
        className={clsx(styles.content, isUser ? styles.contentUser : styles.contentChar)}
        style={streamingMinHeight ? { minHeight: `${streamingMinHeight}px` } : undefined}
      >
        {renderedBlocks}
        <SpindleMessageWidgets messageId={messageId} />
      </div>
      <ImageLightbox src={lightboxSrc} onClose={handleLightboxClose} />
    </>
  )
}
