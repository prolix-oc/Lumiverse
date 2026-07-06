import DOMPurify from 'dompurify'
import { isSafeBrowserNavigationTarget } from '@/lib/navigationSafety'
import { imagesApi } from '@/api/images'

const BASE_FORBID_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'meta', 'base', 'link', 'math']
const BASE_FORBID_ATTR = ['srcdoc', 'formaction']
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|apng|jpeg|jpg|gif|webp|avif|bmp);/i
const DOCUMENT_HTML_RE = /<(?:!doctype\b|html\b|head\b|body\b)/i
const STYLE_TAG_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi
const SVG_LOCAL_REF_RE = /^#[^\s"'`()<>]+$/
const SVG_URL_FUNC_RE = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
const SVG_BLOCKED_TAGS = new Set(['image', 'feimage'])
const SVG_URL_VALUE_ATTRS = new Set([
  'clip-path',
  'cursor',
  'fill',
  'filter',
  'marker-end',
  'marker-mid',
  'marker-start',
  'mask',
  'stroke',
])

type DOMPurifyLike = {
  sanitize: typeof DOMPurify.sanitize
}

interface SanitizeHtmlOptions {
  allowInlineSvg: boolean
  allowStyleTag: boolean
}

let domPurifyInstance: DOMPurifyLike | null = null

function getDOMPurify(): DOMPurifyLike {
  if (typeof DOMPurify.sanitize === 'function') return DOMPurify
  if (domPurifyInstance) return domPurifyInstance

  const root = typeof window !== 'undefined' ? window : (globalThis as { window?: Window }).window
  if (!root) throw new Error('DOMPurify requires a window-like global')

  domPurifyInstance = DOMPurify(root as unknown as Parameters<typeof DOMPurify>[0])
  return domPurifyInstance
}

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

function getKnownAppOrigins(): Set<string> {
  const origins = new Set<string>()
  if (typeof window !== 'undefined' && window.location?.origin) origins.add(window.location.origin)

  try {
    const baseOrigin = new URL(imagesApi.url('origin-probe'), typeof window !== 'undefined' ? window.location.origin : 'http://localhost').origin
    origins.add(baseOrigin)
  } catch {}

  return origins
}

function maybeProxyRemoteImageSrc(src: string): string {
  const trimmed = src.trim()
  if (!trimmed) return trimmed

  try {
    const baseOrigin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost'
    const url = new URL(trimmed, baseOrigin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return trimmed
    if (getKnownAppOrigins().has(url.origin)) return trimmed
    return imagesApi.remoteUrl(url.toString())
  } catch {
    return trimmed
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

function isAllowedLocalSvgReference(rawValue: string): boolean {
  return SVG_LOCAL_REF_RE.test(rawValue.trim())
}

function sanitizeSvgUrlFunctions(value: string): string | null {
  let sawUnsafeUrl = false
  const sanitized = value.replace(SVG_URL_FUNC_RE, (_match, quote: string, rawTarget: string) => {
    const target = rawTarget.trim()
    if (isAllowedLocalSvgReference(target)) return `url(${quote}${target}${quote})`
    sawUnsafeUrl = true
    return ''
  }).trim()

  if (!sawUnsafeUrl) return value.trim() || null
  return sanitized || null
}

function sanitizeSvgStyleAttribute(styleValue: string): string | null {
  const sanitizedDeclarations: string[] = []

  for (const declaration of styleValue.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator < 0) continue

    const property = declaration.slice(0, separator).trim()
    const value = declaration.slice(separator + 1).trim()
    if (!property || !value) continue

    const normalizedProperty = property.toLowerCase()
    if (normalizedProperty === 'behavior' || normalizedProperty === '-moz-binding') continue
    if (/\bexpression\s*\(/i.test(value)) continue

    const sanitizedValue = sanitizeSvgUrlFunctions(value)
    if (!sanitizedValue) continue
    sanitizedDeclarations.push(`${property}: ${sanitizedValue}`)
  }

  return sanitizedDeclarations.length > 0 ? sanitizedDeclarations.join('; ') : null
}

function sanitizeSvgHref(tagName: string, rawValue: string): string | null {
  const trimmed = rawValue.trim()
  if (!trimmed) return null

  if (tagName === 'a') {
    return isSafeBrowserNavigationTarget(trimmed) ? trimmed : null
  }

  return isAllowedLocalSvgReference(trimmed) ? trimmed : null
}

function getSvgRoots(root: ParentNode): Element[] {
  const svgRoots = Array.from(root.querySelectorAll('svg'))
  if (root instanceof Element && root.matches('svg')) svgRoots.unshift(root)
  return svgRoots
}

// DOMPurify strips active content inside SVG, but still allows some passive
// resource-reference surfaces that are fine for static icons only when they are
// limited to local fragment ids.
function sanitizeSvgSubtrees(root: ParentNode): void {
  for (const svgRoot of getSvgRoots(root)) {
    const nodes = [svgRoot, ...Array.from(svgRoot.querySelectorAll('*'))]

    for (const node of nodes) {
      const tagName = node.localName.toLowerCase()
      if (SVG_BLOCKED_TAGS.has(tagName)) {
        node.remove()
        continue
      }

      for (const attr of Array.from(node.attributes)) {
        const attrName = attr.name.toLowerCase()

        if (attrName === 'href' || attrName === 'xlink:href') {
          const sanitizedHref = sanitizeSvgHref(tagName, attr.value)
          if (!sanitizedHref) {
            node.removeAttribute(attr.name)
            continue
          }

          node.setAttribute('href', sanitizedHref)
          if (attr.name !== 'href') node.removeAttribute(attr.name)
          continue
        }

        if (attrName === 'style') {
          const sanitizedStyle = sanitizeSvgStyleAttribute(attr.value)
          if (!sanitizedStyle) node.removeAttribute(attr.name)
          else node.setAttribute(attr.name, sanitizedStyle)
          continue
        }

        if (SVG_URL_VALUE_ATTRS.has(attrName) && /url\(/i.test(attr.value)) {
          const sanitizedValue = sanitizeSvgUrlFunctions(attr.value)
          if (!sanitizedValue) node.removeAttribute(attr.name)
          else node.setAttribute(attr.name, sanitizedValue)
        }
      }
    }
  }
}

function sanitizeHtml(html: string, options: SanitizeHtmlOptions): string {
  const normalizedHtml = normalizeDocumentHtml(html, options.allowStyleTag)
  const styleExtraction = options.allowStyleTag
    ? extractStyleBlocks(normalizedHtml)
    : { htmlWithoutStyles: normalizedHtml, styles: [] }
  const forbidTags = [...BASE_FORBID_TAGS, 'style', 'form']
  if (!options.allowInlineSvg) forbidTags.push('svg')

  const sanitized = getDOMPurify().sanitize(styleExtraction.htmlWithoutStyles, {
    ADD_ATTR: (attrName) => isAllowedCustomAttributeName(attrName),
    ADD_TAGS: options.allowInlineSvg ? ['use'] : undefined,
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: forbidTags,
    FORBID_ATTR: BASE_FORBID_ATTR,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment

  if (options.allowInlineSvg) sanitizeSvgSubtrees(sanitized)
  sanitizeNavigableElements(sanitized)

  for (const img of sanitized.querySelectorAll('img')) {
    const src = img.getAttribute('src') || ''
    if (!isAllowedImageSrc(src)) {
      img.remove()
      continue
    }

    img.setAttribute('src', maybeProxyRemoteImageSrc(src))

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
  return sanitizeHtml(html, { allowInlineSvg: true, allowStyleTag: false })
}

export function sanitizeHtmlIsland(html: string): string {
  return sanitizeHtml(html, { allowInlineSvg: true, allowStyleTag: true })
}
