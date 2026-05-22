import { isSafeBrowserNavigationTarget } from '@/lib/navigationSafety'

const SPINDLE_BOUNDARY_SELECTOR = '[data-spindle-extension-root], [data-spindle-modal], [data-spindle-ext]'

let installed = false

function isInsideSpindleBoundary(target: EventTarget | null): target is Element {
  return target instanceof Element && !!target.closest(SPINDLE_BOUNDARY_SELECTOR)
}

function sanitizeNavigationAttribute(el: Element, attr: 'href' | 'action' | 'formaction'): void {
  const rawValue = el.getAttribute(attr) || ''
  if (!rawValue || isSafeBrowserNavigationTarget(rawValue)) return
  el.removeAttribute(attr)
  console.warn(`[Spindle] Removed unsafe extension ${attr}:`, rawValue)
}

function sanitizeNavigableElements(root: Element): void {
  if (!root.closest(SPINDLE_BOUNDARY_SELECTOR) && !root.matches(SPINDLE_BOUNDARY_SELECTOR)) return

  if (root.matches('a[href], area[href]')) sanitizeNavigationAttribute(root, 'href')
  if (root.matches('form[action]')) sanitizeNavigationAttribute(root, 'action')
  if (root.matches('[formaction]')) sanitizeNavigationAttribute(root, 'formaction')

  for (const el of root.querySelectorAll('a[href], area[href]')) {
    sanitizeNavigationAttribute(el, 'href')
  }

  for (const el of root.querySelectorAll('form[action]')) {
    sanitizeNavigationAttribute(el, 'action')
  }

  for (const el of root.querySelectorAll('[formaction]')) {
    sanitizeNavigationAttribute(el, 'formaction')
  }
}

export function installSpindleNavigationGuards(): void {
  if (installed || typeof document === 'undefined') return
  installed = true

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        sanitizeNavigableElements(mutation.target)
        continue
      }

      for (const node of mutation.addedNodes) {
        if (node instanceof Element) sanitizeNavigableElements(node)
      }
    }
  })

  if (document.body) {
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'action', 'formaction'],
    })
  }

  document.addEventListener('click', (event) => {
    if (!isInsideSpindleBoundary(event.target)) return

    const link = event.target.closest('a[href], area[href]') as HTMLAnchorElement | HTMLAreaElement | null
    if (!link) return

    const rawHref = link.getAttribute('href') || ''
    if (isSafeBrowserNavigationTarget(rawHref)) return

    event.preventDefault()
    event.stopPropagation()
    console.warn('[Spindle] Blocked unsafe extension navigation target:', rawHref)
  }, true)

  document.addEventListener('submit', (event) => {
    if (!(event.target instanceof HTMLFormElement)) return
    if (!event.target.closest(SPINDLE_BOUNDARY_SELECTOR)) return

    const rawAction = event.target.getAttribute('action') || ''
    if (!rawAction || isSafeBrowserNavigationTarget(rawAction)) return

    event.preventDefault()
    event.stopPropagation()
    console.warn('[Spindle] Blocked unsafe extension form action:', rawAction)
  }, true)
}
