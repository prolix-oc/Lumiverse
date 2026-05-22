import DOMPurify from 'dompurify'
import { isSafeBrowserNavigationTarget } from '@/lib/navigationSafety'

const BASE_FORBID_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'meta', 'base', 'link', 'svg', 'math']
const BASE_FORBID_ATTR = ['srcdoc', 'formaction']
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|apng|jpeg|jpg|gif|webp|avif|bmp);/i
const DOCUMENT_HTML_RE = /<(?:!doctype\b|html\b|head\b|body\b)/i
const STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi

function isAllowedCustomAttributeName(attrName: string): boolean {
  const normalized = attrName.toLowerCase()
  return normalized.includes('-')
    && !normalized.startsWith('data-')
    && !normalized.startsWith('aria-')
    && !normalized.includes(':')
}

function normalizeDocumentHtml(html: string, allowStyleTag: boolean): string {
  if (!DOCUMENT_HTML_RE.test(html)) return html

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const parts: string[] = []

  if (allowStyleTag) {
    for (const style of doc.head.querySelectorAll('style')) {
      parts.push(style.outerHTML)
    }
  }

  const bodyHtml = doc.body.innerHTML.trim()
  if (bodyHtml) parts.push(bodyHtml)

  return parts.length > 0 ? parts.join('\n') : html
}

function isBareRelativeImageSrc(src: string): boolean {
  // Preserve Risu/local asset compatibility for filenames like `foo.webp` and
  // nested relative paths like `images/foo.png` without relying on URL parsing.
  return !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)
}

function isAllowedImageSrc(src: string): boolean {
  const trimmed = src.trim()
  if (!trimmed) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true
  if (isBareRelativeImageSrc(trimmed)) return true
  if (trimmed.startsWith('blob:')) return true
  if (SAFE_DATA_IMAGE_RE.test(trimmed)) return true

  try {
    const url = new URL(trimmed, window.location.origin)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function sanitizeNavigationAttribute(el: Element, attr: 'href' | 'action' | 'formaction'): void {
  const rawValue = el.getAttribute(attr) || ''
  if (!rawValue || isSafeBrowserNavigationTarget(rawValue)) return
  el.removeAttribute(attr)
}

function sanitizeNavigableElements(root: ParentNode): void {
  for (const el of root.querySelectorAll('a[href], area[href]')) {
    sanitizeNavigationAttribute(el, 'href')
    if (el.getAttribute('href')) {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    } else {
      el.removeAttribute('target')
      el.removeAttribute('rel')
    }
  }

  for (const el of root.querySelectorAll('form[action]')) {
    sanitizeNavigationAttribute(el, 'action')
  }

  for (const el of root.querySelectorAll('[formaction]')) {
    sanitizeNavigationAttribute(el, 'formaction')
  }
}

function sanitizeIslandCss(css: string): string {
  return css
    .replace(/<\/style/gi, '<\\/style')
    .replace(/@import\b[^;]*(?:;|$)/gi, '')
    .replace(/url\(\s*(['"]?)\s*javascript:[\s\S]*?\)/gi, 'url($1about:blank)')
    .replace(/\bexpression\s*\(/gi, 'x-expression(')
    .replace(/\b(?:behavior|-moz-binding)\s*:/gi, 'x-blocked-property:')
}

function extractStyleBlocks(html: string): { htmlWithoutStyles: string; styles: string[] } {
  const styles: string[] = []
  STYLE_TAG_RE.lastIndex = 0
  const htmlWithoutStyles = html.replace(STYLE_TAG_RE, (_match, css: string) => {
    const sanitizedCss = sanitizeIslandCss(css)
    if (sanitizedCss.trim()) styles.push(sanitizedCss)
    return ''
  })
  return { htmlWithoutStyles, styles }
}

function sanitizeHtml(html: string, allowStyleTag: boolean): string {
  const normalizedHtml = normalizeDocumentHtml(html, allowStyleTag)
  const styleExtraction = allowStyleTag
    ? extractStyleBlocks(normalizedHtml)
    : { htmlWithoutStyles: normalizedHtml, styles: [] }
  const sanitized = DOMPurify.sanitize(styleExtraction.htmlWithoutStyles, {
    ADD_ATTR: (attrName) => isAllowedCustomAttributeName(attrName),
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: [...BASE_FORBID_TAGS, 'style', 'form'],
    FORBID_ATTR: BASE_FORBID_ATTR,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment

  sanitizeNavigableElements(sanitized)

  for (const img of sanitized.querySelectorAll('img')) {
    const src = img.getAttribute('src') || ''
    if (!isAllowedImageSrc(src)) {
      img.remove()
      continue
    }

    // Responsive srcsets are harder to constrain safely than a single image URL.
    img.removeAttribute('srcset')
  }

  const wrapper = document.createElement('div')
  for (const css of styleExtraction.styles) {
    const style = document.createElement('style')
    style.textContent = css
    wrapper.appendChild(style)
  }
  wrapper.appendChild(sanitized)
  return wrapper.innerHTML
}

export function sanitizeRichHtml(html: string): string {
  return sanitizeHtml(html, false)
}

export function sanitizeHtmlIsland(html: string): string {
  return sanitizeHtml(html, true)
}
