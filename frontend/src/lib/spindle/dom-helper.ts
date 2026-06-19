import DOMPurify from 'dompurify'
import type { SpindleDOMHelper } from 'lumiverse-spindle-types'
import { createSandboxFrame } from './sandbox-frame'
import {
  computeRelativePath,
  generateInjectionId,
  register as registerInjection,
  unregisterByElement,
  unregisterByExtension,
} from './dom-injection-registry'

const DATA_ATTR = 'data-spindle-ext'
const DATA_INJ_ATTR = 'data-spindle-inj-id'
// Private host attribute marking a chat-message bubble root. Extensions
// MUST NOT read this directly — it's surfaced through the typed
// dom.getMessageId / dom.findMessageElement / dom.listMessageElements
// methods so we can change the attribute name without breaking them.
const DATA_MSG_ID_ATTR = 'data-message-id'
const FORBIDDEN_CREATE_TAGS = new Set(['iframe', 'frame', 'object', 'embed'])

export function createDOMHelper(
  extensionId: string,
  corsProxy?: (url: string, options?: any) => Promise<any>,
  canEval?: () => boolean
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

      const resolvedPosition: InsertPosition = position || 'beforeend'
      const injectionId = generateInjectionId()

      // Wrap in a container so we can track it. The injection id lets us
      // (a) idempotently skip re-inserting on replay if the wrapper is
      // already there, and (b) match the wrapper back to its registry
      // record on remove/cleanup so we can drop it from the replay list.
      const wrapper = document.createElement('div')
      wrapper.setAttribute(DATA_ATTR, extensionId)
      wrapper.setAttribute(DATA_INJ_ATTR, injectionId)
      wrapper.appendChild(sanitized)

      el.insertAdjacentElement(resolvedPosition, wrapper)
      trackedElements.add(wrapper)

      // Register for virtualizer-remount replay if this injection landed
      // inside a chat message bubble. Injections elsewhere (chat header,
      // sidebars, modals, etc.) skip registration — those DOM trees aren't
      // virtualized so the original wrapper stays put on its own.
      const messageRoot = el.closest('[data-message-id]')
      if (messageRoot) {
        const messageId = messageRoot.getAttribute('data-message-id')
        if (messageId) {
          const relativePath = computeRelativePath(messageRoot, el)
          if (relativePath !== null) {
            registerInjection(messageId, {
              injectionId,
              extensionId,
              rawHtml: html,
              relativePath,
              position: resolvedPosition,
              element: wrapper,
            })
          }
        }
      }

      return wrapper
    },

    uninject(element: Element): void {
      unregisterByElement(element)
      trackedElements.delete(element)
      element.remove()
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
      // Honor allowEval only if the extension holds the unsafe_eval grant
      // (fail-closed).
      const gatedOptions = {
        ...options,
        allowEval: options.allowEval === true && canEval?.() === true,
      }
      const handle = createSandboxFrame(extensionId, gatedOptions, corsProxy)
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

    getMessageId(target: Element): string | null {
      if (!target || typeof target.closest !== 'function') return null
      const bubble = target.closest(`[${DATA_MSG_ID_ATTR}]`)
      return bubble?.getAttribute(DATA_MSG_ID_ATTR) ?? null
    },

    findMessageElement(messageId: string): Element | null {
      if (!messageId) return null
      // Message ids are UUIDs in practice, but escape defensively in case
      // a future id format contains characters that confuse selector
      // parsing. CSS.escape is supported in every modern browser; the
      // raw fallback keeps the helper usable in unusual environments.
      const safe = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
        ? CSS.escape(messageId)
        : messageId
      return document.querySelector(`[${DATA_MSG_ID_ATTR}="${safe}"]`)
    },

    listMessageElements(): Array<{ messageId: string; element: Element }> {
      const nodes = document.querySelectorAll(`[${DATA_MSG_ID_ATTR}]`)
      const results: Array<{ messageId: string; element: Element }> = []
      for (const el of nodes) {
        const id = el.getAttribute(DATA_MSG_ID_ATTR)
        if (id) results.push({ messageId: id, element: el })
      }
      return results
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

      // Drop this extension's entries from the bubble-injection registry
      // too — without this, an extension that was uninstalled mid-session
      // would still ghost-inject its content whenever the user scrolled
      // past one of its previously-affected messages.
      unregisterByExtension(extensionId)
    },
  }
}
