import DOMPurify from 'dompurify'
import type { SpindleDOMHelper } from 'lumiverse-spindle-types'
import { createSandboxFrame } from './sandbox-frame'
import {
  computeRelativePath,
  generateInjectionId,
  isOuterMessageRoot,
  register as registerInjection,
  unregisterByElement,
  unregisterByExtension,
} from './dom-injection-registry'
import { registerLiveRoot, unregisterLiveRoot } from './live-root-registry'
import {
  EXTENSION_IDENTIFIER_PATTERN,
  EXTENSION_ROOT_ATTRIBUTES,
  stampExtensionRoot,
} from './extension-root-stamp'

const DATA_ATTR = 'data-spindle-ext'
const DATA_INJ_ATTR = 'data-spindle-inj-id'
// Private host attribute marking a chat-message bubble root. Extensions
// MUST NOT read this directly — it's surfaced through the typed
// dom.getMessageId / dom.findMessageElement / dom.listMessageElements
// methods so we can change the attribute name without breaking them.
const DATA_MSG_ID_ATTR = 'data-message-id'
const FORBIDDEN_CREATE_TAGS = new Set(['iframe', 'frame', 'object', 'embed'])
declare const CSSScopeRule: unknown

export interface ScopedStyleOptions {
  scope?: 'global' | 'root'
}

export type SpindleDOMHelperWithScopedStyles = SpindleDOMHelper & {
  addStyle(css: string, options?: ScopedStyleOptions): () => void
}

export function createDOMHelper(
  extensionId: string,
  manifestIdentifier: string,
  corsProxy?: (url: string, options?: any) => Promise<any>,
  canEval?: () => boolean,
  assertActive: () => void = () => {},
  generation?: number,
): SpindleDOMHelperWithScopedStyles {
  const trackedElements = new Set<Element>()
  const trackedRootUnregisters = new Map<Element, () => void>()
  const trackedDisposers: (() => void)[] = []
  const trackedStyles: (() => void)[] = []

  const releaseElement = (element: Element): void => {
    trackedRootUnregisters.get(element)?.()
    trackedRootUnregisters.delete(element)
    trackedElements.delete(element)
    // An extension may still hold the wrapper. Sever its parent link so
    // that reference cannot retain the entire old message/chat tree.
    element.remove()
  }

  return {
    inject(target: string | Element, html: string, position?: InsertPosition): Element {
      assertActive()
      const el = typeof target === 'string' ? document.querySelector(target) : target
      if (!el) throw new Error(`Target not found: ${target}`)

      const sanitized = DOMPurify.sanitize(html, {
        ADD_ATTR: [DATA_ATTR],
        RETURN_DOM_FRAGMENT: true,
        // Explicitly forbid frame-based elements — Spindle extensions must never use
        // iframes, frames, objects, or embeds. These are blocked by CSP as well, but
        // we also strip them at the sanitization layer for defense-in-depth.
        FORBID_TAGS: ['iframe', 'frame', 'object', 'embed', 'form'],
        FORBID_ATTR: [
          'formaction',
          'data-spindle-ext',
          'data-spindle-extension-root',
          'data-spindle-extension-id',
          'data-spindle-ext-id',
        ],
      })

      const resolvedPosition: InsertPosition = position || 'beforeend'
      const injectionId = generateInjectionId()

      // Wrap in a container so we can track it. The injection id lets us
      // (a) idempotently skip re-inserting on replay if the wrapper is
      // already there, and (b) match the wrapper back to its registry
      // record on remove/cleanup so we can drop it from the replay list.
      const wrapper = document.createElement('div')
      stampExtensionRoot(wrapper, extensionId, DATA_ATTR)
      wrapper.setAttribute(DATA_INJ_ATTR, injectionId)
      wrapper.appendChild(sanitized)

      let unregisterRoot: (() => void) | undefined
      try {
        el.insertAdjacentElement(resolvedPosition, wrapper)
        assertActive()
        unregisterRoot = registerLiveRoot(extensionId, wrapper, null, generation)
        trackedRootUnregisters.set(wrapper, unregisterRoot)
        trackedElements.add(wrapper)
      } catch (error) {
        unregisterRoot?.()
        wrapper.remove()
        throw error
      }

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
              outer: isOuterMessageRoot(messageId, messageRoot),
              element: wrapper,
              dispose: () => releaseElement(wrapper),
            })
          }
        }
      }

      return wrapper
    },

    uninject(element: Element): void {
      unregisterByElement(element)
      releaseElement(element)
    },

    addStyle(css: string, options?: ScopedStyleOptions): () => void {
      assertActive()
      const style = document.createElement('style')
      stampExtensionRoot(style, extensionId, DATA_ATTR)

      if (options?.scope === 'root') {
        if (!EXTENSION_IDENTIFIER_PATTERN.test(manifestIdentifier)) {
          throw new Error('SCOPE_IDENTIFIER_INVALID')
        }
        installScopedStyle(style, css, manifestIdentifier)
      } else {
        style.textContent = css
        document.head.appendChild(style)
      }

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
      assertActive()
      if (FORBIDDEN_CREATE_TAGS.has(String(tag).toLowerCase())) {
        throw new Error(`Forbidden element tag: ${tag}. Use ctx.dom.createSandboxFrame() for isolated scriptable widgets.`)
      }
      const el = document.createElement(tag)
      stampExtensionRoot(el, extensionId, DATA_ATTR)
      if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
          if (EXTENSION_ROOT_ATTRIBUTES.has(key.toLowerCase())) continue
          el.setAttribute(key, value)
        }
      }
      trackedElements.add(el)
      return el
    },

    createSandboxFrame(options) {
      assertActive()
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
      for (const [element, unregisterRoot] of trackedRootUnregisters) {
        unregisterRoot()
        element.remove()
      }
      trackedRootUnregisters.clear()
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

let scopedStyleNativeSupport: boolean | undefined
const fallbackWarnings = new Set<string>()

function supportsNativeScope(): boolean {
  if (scopedStyleNativeSupport !== undefined) return scopedStyleNativeSupport
  scopedStyleNativeSupport = typeof CSSScopeRule !== 'undefined'
  return scopedStyleNativeSupport
}

function installScopedStyle(style: HTMLStyleElement, css: string, identifier: string): void {
  const selector = `[data-spindle-ext-id="${identifier}"]`
  if (supportsNativeScope()) {
    style.textContent = `${buildScopedStylePrelude(identifier)} {\n${css}\n}`
    document.head.appendChild(style)
    return
  }

  style.textContent = css
  document.head.appendChild(style)
  try {
    const sheet = style.sheet
    if (!sheet) throw new Error('missing stylesheet')
    rewriteScopedRules(sheet.cssRules, selector)
    if (!fallbackWarnings.has(identifier)) {
      fallbackWarnings.add(identifier)
      console.warn(`[spindle] Native @scope is unavailable; using conservative selector fallback for ${identifier}`)
    }
  } catch (error) {
    style.remove()
    throw new Error(`SCOPED_STYLE_FALLBACK_UNAVAILABLE: ${String(error)}`)
  }
}

export function buildScopedStylePrelude(identifier: string): string {
  if (!EXTENSION_IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error('SCOPE_IDENTIFIER_INVALID')
  }
  return `@scope ([data-spindle-ext-id="${identifier}"])`
}

function rewriteScopedRules(rules: CSSRuleList, selector: string): void {
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules.item(index)
    if (!rule) continue

    if ('selectorText' in rule && typeof rule.selectorText === 'string') {
      const selectors = splitSelectorList(rule.selectorText)
      rule.selectorText = selectors
        .flatMap((item) => [`${selector}${item}`, `${selector} ${item}`])
        .join(', ')
      continue
    }

    if ('cssRules' in rule) {
      const nestedRules = (rule as CSSGroupingRule).cssRules
      if (nestedRules) rewriteScopedRules(nestedRules, selector)
    }
  }
}

function splitSelectorList(selectorText: string): string[] {
  const selectors: string[] = []
  let start = 0
  let brackets = 0
  let parentheses = 0
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let index = 0; index < selectorText.length; index += 1) {
    const char = selectorText[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === '[') brackets += 1
    else if (char === ']') brackets = Math.max(0, brackets - 1)
    else if (char === '(') parentheses += 1
    else if (char === ')') parentheses = Math.max(0, parentheses - 1)
    else if (char === ',' && brackets === 0 && parentheses === 0) {
      selectors.push(selectorText.slice(start, index).trim())
      start = index + 1
    }
  }

  const tail = selectorText.slice(start).trim()
  if (tail) selectors.push(tail)
  return selectors
}
