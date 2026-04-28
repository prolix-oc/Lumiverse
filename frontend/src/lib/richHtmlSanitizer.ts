import DOMPurify from 'dompurify'

const BASE_FORBID_TAGS = ['script', 'iframe', 'frame', 'object', 'embed', 'meta', 'base', 'link', 'svg', 'math']
const BASE_FORBID_ATTR = ['srcdoc', 'formaction']
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|apng|jpeg|jpg|gif|webp|avif|bmp);/i

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

function sanitizeHtml(html: string, allowStyleTag: boolean): string {
  const sanitized = DOMPurify.sanitize(html, {
    ADD_TAGS: allowStyleTag ? ['style'] : [],
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: true,
    FORBID_TAGS: allowStyleTag
      ? [...BASE_FORBID_TAGS, 'form']
      : [...BASE_FORBID_TAGS, 'style', 'form', 'input', 'button', 'textarea', 'select', 'option'],
    FORBID_ATTR: BASE_FORBID_ATTR,
    RETURN_DOM_FRAGMENT: true,
  }) as DocumentFragment

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
  wrapper.appendChild(sanitized)
  return wrapper.innerHTML
}

export function sanitizeRichHtml(html: string): string {
  return sanitizeHtml(html, false)
}

export function sanitizeHtmlIsland(html: string): string {
  return sanitizeHtml(html, true)
}
