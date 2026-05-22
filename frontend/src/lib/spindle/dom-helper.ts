import DOMPurify from 'dompurify'
import type { SpindleDOMHelper } from 'lumiverse-spindle-types'
import { createSandboxFrame } from './sandbox-frame'

const DATA_ATTR = 'data-spindle-ext'
const FORBIDDEN_CREATE_TAGS = new Set(['iframe', 'frame', 'object', 'embed'])

export function createDOMHelper(
  extensionId: string,
  corsProxy?: (url: string, options?: any) => Promise<any>
): SpindleDOMHelper {
  const trackedElements = new Set<Element>()
  const trackedStyles: (() => void)[] = []
  const trackedDisposers: (() => void)[] = []

  return {
    inject(target: string | Element, html: string, position?: InsertPosition): Element {
      const el = typeof target === 'string' ? document.querySelector(target) : target
      if (!el) throw new Error(`Target not found: ${target}`)

      const sanitized = DOMPurify.sanitize(html, {
        ADD_ATTR: [DATA_ATTR],
        RETURN_DOM_FRAGMENT: true,
        // Explicitly forbid frame-based elements — Spindle extensions must never use
        // iframes, frames, objects, or embeds. These are blocked by CSP as well, but
        // we also strip them at the sanitization layer for defense-in-depth.
        FORBID_TAGS: ['iframe', 'frame', 'object', 'embed', 'form'],
        FORBID_ATTR: ['formaction'],
      })

      // Wrap in a container so we can track it
      const wrapper = document.createElement('div')
      wrapper.setAttribute(DATA_ATTR, extensionId)
      wrapper.appendChild(sanitized)

      el.insertAdjacentElement(position || 'beforeend', wrapper)
      trackedElements.add(wrapper)

      return wrapper
    },

    addStyle(css: string): () => void {
      const style = document.createElement('style')
      style.setAttribute(DATA_ATTR, extensionId)
      style.textContent = css
      document.head.appendChild(style)

      const remove = () => {
        style.remove()
        const idx = trackedStyles.indexOf(remove)
        if (idx !== -1) trackedStyles.splice(idx, 1)
      }

      trackedStyles.push(remove)
      return remove
    },

    createElement<K extends keyof HTMLElementTagNameMap>(
      tag: K,
      attrs?: Record<string, string>
    ): HTMLElementTagNameMap[K] {
      if (FORBIDDEN_CREATE_TAGS.has(String(tag).toLowerCase())) {
        throw new Error(`Forbidden element tag: ${tag}. Use ctx.dom.createSandboxFrame() for isolated scriptable widgets.`)
      }
      const el = document.createElement(tag)
      el.setAttribute(DATA_ATTR, extensionId)
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          el.setAttribute(key, value)
        }
      }
      trackedElements.add(el)
      return el
    },

    createSandboxFrame(options) {
      const handle = createSandboxFrame(extensionId, options, corsProxy)
      trackedElements.add(handle.element)
      const originalDestroy = handle.destroy.bind(handle)

      const dispose = () => {
        originalDestroy()
        trackedElements.delete(handle.element)
        const idx = trackedDisposers.indexOf(dispose)
        if (idx !== -1) trackedDisposers.splice(idx, 1)
      }

      trackedDisposers.push(dispose)

      handle.destroy = () => {
        if (!trackedElements.has(handle.element)) {
          originalDestroy()
          return
        }
        dispose()
      }

      return handle
    },

    query(selector: string): Element | null {
      return document.querySelector(`[${DATA_ATTR}="${extensionId}"] ${selector}`)
    },

    queryAll(selector: string): Element[] {
      return Array.from(
        document.querySelectorAll(`[${DATA_ATTR}="${extensionId}"] ${selector}`)
      )
    },

    cleanup(): void {
      for (const el of trackedElements) {
        el.remove()
      }
      trackedElements.clear()

      for (const remove of [...trackedStyles]) {
        remove()
      }
      trackedStyles.length = 0

      for (const dispose of [...trackedDisposers]) {
        dispose()
      }
      trackedDisposers.length = 0
    },
  }
}
