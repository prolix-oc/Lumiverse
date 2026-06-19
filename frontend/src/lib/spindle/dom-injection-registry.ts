import DOMPurify from 'dompurify'
import { useStore } from '@/store'

/**
 * Host-side replay registry for Spindle `dom.inject()` calls that land
 * inside a virtualized message bubble.
 *
 * Problem this solves:
 *   The chat list (MessageList.tsx) virtualizes message rows. When a row
 *   is scrolled off-screen past the overscan window — or has its measured
 *   height changed in a way that pushes it out of range — the row's DOM
 *   is destroyed. Extensions that injected content imperatively via
 *   `dom.inject()` lose their wrapper because the wrapper was a child of
 *   the now-destroyed row, and nothing in React's tree knows to put it
 *   back when the row remounts.
 *
 * How this fixes it without changing the extension API:
 *   1. `dom.inject()` (host-side, in dom-helper.ts) calls `register()` here
 *      after appending the wrapper, capturing enough info to re-create
 *      the injection later: raw HTML, extension id, the wrapper's
 *      relative path from the message-bubble root, and the requested
 *      insert position.
 *   2. On bubble mount/remount, the bubble component calls `replay()`
 *      with its messageId + root element. We re-create any wrappers
 *      that aren't already present in the DOM and re-insert them at the
 *      same relative position.
 *
 * Element-preservation contract:
 *   The wrapper returned from `dom.inject()` is held in the registry and
 *   *moved* (not recreated) into the new bubble on replay. That means
 *   form-control state, event listeners bound directly to the wrapper
 *   subtree, and refs the extension is holding all survive virtualization
 *   round-trips. Identity of the returned Element is stable for the life
 *   of the injection. The re-parse path remains as a fallback for cases
 *   where the cached element has been GC'd or never recorded (e.g.
 *   historical records loaded without an element reference).
 *
 * Limitations (worth knowing, deliberately accepted):
 *   • Targets identified by structurally-unstable selectors (e.g. the 3rd
 *     swipe action button) may fail to resolve post-remount. We log a
 *     warning and skip that record rather than throw.
 *   • An extension that wants to deliberately drop an injection must call
 *     `dom.uninject(wrapper)` (or `cleanup()` for everything). Calling
 *     `wrapper.remove()` directly leaves the registry record in place, so
 *     the host will resurrect the wrapper on the next bubble remount.
 */

const DATA_EXT_ATTR = 'data-spindle-ext'
const DATA_INJ_ATTR = 'data-spindle-inj-id'

export interface InjectionRecord {
  /** Stable id assigned at first inject, preserved across replays so a
   *  later `dom.uninject()` (or cleanup) can find this record. */
  injectionId: string
  extensionId: string
  /** Raw user-supplied HTML. Used to rebuild the wrapper if the cached
   *  element is unavailable (never recorded, GC'd, or the extension
   *  invalidated it). Sanitized on rebuild with the same DOMPurify config
   *  as the original inject. */
  rawHtml: string
  /** nth-child-based selector path from the message-bubble root down to
   *  the target element. Empty string means "the message root itself". */
  relativePath: string
  position: InsertPosition
  /** The wrapper Element created at first inject. Preserved across
   *  remounts so form-control state, event listeners, and refs survive
   *  virtualization. Null only when the record was created without an
   *  element (no current call site does this — reserved for forward-
   *  compatibility with historical-record rehydration). */
  element: Element | null
}

const records = new Map<string, InjectionRecord[]>()

let nextInjectionSequence = 1

export function generateInjectionId(): string {
  // Sequence + ms timestamp + random suffix. Sequence keeps ids stable
  // within a session; the timestamp + random tail makes collisions
  // basically impossible across module re-imports during dev HMR.
  const seq = nextInjectionSequence++
  return `inj-${seq}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function register(messageId: string, record: InjectionRecord): void {
  // Lazy GC bootstrap — the moment we have something to clean up, start
  // watching the store. Idempotent.
  ensureGcSetup()
  const list = records.get(messageId)
  if (list) {
    list.push(record)
  } else {
    records.set(messageId, [record])
  }
}

export function unregisterByInjectionId(injectionId: string): void {
  for (const [messageId, list] of records) {
    const filtered = list.filter((r) => r.injectionId !== injectionId)
    if (filtered.length === 0) {
      records.delete(messageId)
    } else if (filtered.length !== list.length) {
      records.set(messageId, filtered)
    }
  }
}

/** Drop a record by its wrapper element. Reads the injection id from the
 *  wrapper's `data-spindle-inj-id` attribute. No-op if the element isn't a
 *  Spindle wrapper. Used by `dom.uninject()` so extensions can deliberately
 *  retire an injection without it resurrecting on the next bubble remount. */
export function unregisterByElement(element: Element): void {
  const injectionId = element.getAttribute(DATA_INJ_ATTR)
  if (!injectionId) return
  unregisterByInjectionId(injectionId)
}

export function unregisterByExtension(extensionId: string): void {
  for (const [messageId, list] of records) {
    const filtered = list.filter((r) => r.extensionId !== extensionId)
    if (filtered.length === 0) {
      records.delete(messageId)
    } else if (filtered.length !== list.length) {
      records.set(messageId, filtered)
    }
  }
}

/** Drop every record for a given messageId. Used by the store-subscription
 *  GC below when a message is deleted or its chat is switched away from. */
export function unregisterByMessageId(messageId: string): void {
  records.delete(messageId)
}

// ─────────────────────────────────────────────────────────────────────────
// Store-subscription GC — keeps the registry from accumulating dead
// entries when messages are deleted from a chat OR the user navigates
// to a different chat. Both surface as "ids that were in the store
// previously and aren't anymore" in a single messages-array diff:
//   • Message delete  → store.messages goes from […, m, …] → [..., ...]
//   • Chat switch     → store.messages goes from [...A] → [] (then later
//                       fills with [...B]; the [...A] → [] step is the
//                       one we act on; the [] → [...B] step adds nothing
//                       to clean up)
//
// Lazy-init from the first register() call so importing this module from
// a non-React context doesn't pull in store side effects unnecessarily.
// One subscription per app lifetime — fast-path returns immediately on
// state changes that didn't touch messages.

let gcSetup = false

function ensureGcSetup(): void {
  if (gcSetup) return
  gcSetup = true

  let previousMessages = useStore.getState().messages

  useStore.subscribe((state) => {
    const currentMessages = state.messages
    // Fast path: most store updates don't touch the messages array.
    // Zustand slice updates produce new arrays on mutation, so reference
    // equality is a reliable shortcut.
    if (currentMessages === previousMessages) return

    const previous = previousMessages
    previousMessages = currentMessages

    // Find ids that disappeared. We only build the previous-ids set when
    // there's actually been a change; in the common case the diff is
    // empty (new message added) and we return without touching records.
    if (previous.length === 0) return

    const currentIds = new Set<string>()
    for (const m of currentMessages) currentIds.add(m.id)

    for (const prev of previous) {
      if (!currentIds.has(prev.id) && records.has(prev.id)) {
        records.delete(prev.id)
      }
    }
  })
}

/**
 * Compute a nth-child-based selector path from `root` down to `target`.
 * Returns null when target isn't a descendant of root, or when the path
 * can't be expressed (orphan node mid-walk).
 *
 * We use nth-child rather than nth-of-type so the selector matches the
 * exact child slot even when sibling tags differ. The path is structural
 * only — it doesn't reference class names or ids — which is what we want
 * for replay across remounts (React's classNames can shift on re-render).
 */
export function computeRelativePath(root: Element, target: Element): string | null {
  if (root === target) return ''
  if (!root.contains(target)) return null

  const segments: string[] = []
  let cur: Element | null = target
  while (cur && cur !== root) {
    const parent = cur.parentElement
    if (!parent) return null
    const idx = Array.prototype.indexOf.call(parent.children, cur)
    if (idx < 0) return null
    segments.unshift(`:nth-child(${idx + 1})`)
    cur = parent
  }
  return segments.length > 0 ? segments.join(' > ') : ''
}

function resolveRelativePath(root: Element, path: string): Element | null {
  if (path === '') return root
  try {
    // `:scope >` anchors the first segment to a direct child of root.
    return root.querySelector(`:scope > ${path}`)
  } catch {
    return null
  }
}

/**
 * Re-insert any registered injections for this message into the freshly
 * mounted root element. Safe to call on every mount — idempotent because
 * a wrapper already inside `root` is a no-op move.
 *
 * Primary path: move the cached wrapper element into the new bubble, which
 * preserves form state, listeners, and refs. Fallback path: re-parse
 * rawHtml when no cached element exists (historical-record rehydration).
 */
export function replay(messageId: string, root: Element): void {
  const list = records.get(messageId)
  if (!list || list.length === 0) return

  for (const record of list) {
    // Already in place (bubble never truly unmounted, or replay fired
    // redundantly). insertAdjacentElement would just move it back to the
    // same slot, but skipping is cheaper and avoids spurious mutations.
    if (record.element && root.contains(record.element)) continue

    // Safety net: a wrapper with the same injection id is present from
    // some path we didn't take. Don't double-insert.
    if (root.querySelector(`[${DATA_INJ_ATTR}="${record.injectionId}"]`)) continue

    const targetEl = resolveRelativePath(root, record.relativePath)
    if (!targetEl) {
      console.warn(
        `[spindle] Could not resolve replay target for injection ${record.injectionId} ` +
        `in message ${messageId} — bubble DOM structure changed since registration. Skipping.`,
      )
      continue
    }

    let wrapper = record.element
    if (!wrapper) {
      const sanitized = DOMPurify.sanitize(record.rawHtml, {
        ADD_ATTR: [DATA_EXT_ATTR],
        RETURN_DOM_FRAGMENT: true,
        FORBID_TAGS: ['iframe', 'frame', 'object', 'embed', 'form'],
        FORBID_ATTR: ['formaction'],
      })
      wrapper = document.createElement('div')
      wrapper.setAttribute(DATA_EXT_ATTR, record.extensionId)
      wrapper.setAttribute(DATA_INJ_ATTR, record.injectionId)
      wrapper.appendChild(sanitized)
      record.element = wrapper
    }

    // insertAdjacentElement detaches the wrapper from any prior parent
    // and reattaches at the requested position. Identity is preserved.
    targetEl.insertAdjacentElement(record.position, wrapper)
  }
}

/** Test/debug helper — drop everything. */
export function _resetInjectionRegistry(): void {
  records.clear()
  nextInjectionSequence = 1
}
