import DOMPurify from 'dompurify'
import type { SpindleDOMHelper } from 'lumiverse-spindle-types'

const DATA_ATTR = 'data-spindle-ext'

export function createDOMHelper(extensionId: string): SpindleDOMHelper {
  const trackedElements = new Set<Element>()
  const trackedStyles: (() => void)[] = []

  return {
    inject(target: string | Element, html: string, position?: InsertPosition): Element {
      const el = typeof target === 'string' ? document.querySelector(target) : target
      if (!el) throw new Error(`Target not found: ${target}`)

      const sanitized = DOMPurify.sanitize(html, {
        ADD_ATTR: [DATA_ATTR],
        RETURN_DOM_FRAGMENT: true,
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
    },
  }
}
