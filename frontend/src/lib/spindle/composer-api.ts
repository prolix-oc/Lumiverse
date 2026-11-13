// Bridge between extensions and the chat composer (the message input of the open chat).
// InputArea owns the draft as React state; while it is mounted it registers a
// controller here, and each extension gets a `ctx.composer` view over it.
import type {
  SpindleComposerAPI,
  SpindleComposerInsertPosition,
  SpindleComposerState,
} from 'lumiverse-spindle-types'
import { scheduleMicrotask } from '@/lib/schedule-microtask'

/** Implemented by the mounted InputArea. Text writes apply synchronously. */
export interface ComposerController {
  getChatId(): string
  getText(): string
  setText(text: string): void
  insertText(text: string, at: SpindleComposerInsertPosition): void
  focus(): void
  send(): Promise<void>
}

const UNMOUNTED: SpindleComposerState = Object.freeze({ mounted: false, chatId: null, text: '' })

let controller: ComposerController | null = null
let published: SpindleComposerState = UNMOUNTED
let notifyQueued = false
const listeners = new Set<(state: SpindleComposerState) => void>()

function readState(): SpindleComposerState {
  if (!controller) return UNMOUNTED
  return Object.freeze({ mounted: true, chatId: controller.getChatId(), text: controller.getText() })
}

/**
 * Tells listeners that the composer changed. Delivery is deferred to a
 * microtask so a listener can call back into the composer outside React's
 * render and effect phases; bursts collapse into one notification.
 */
export function notifyComposerChanged(): void {
  if (notifyQueued) return
  notifyQueued = true
  scheduleMicrotask(() => {
    notifyQueued = false
    const next = readState()
    if (next.mounted === published.mounted && next.chatId === published.chatId && next.text === published.text) return
    published = next
    for (const listener of [...listeners]) {
      if (!listeners.has(listener)) continue
      try {
        listener(next)
      } catch (error) {
        console.error('[Spindle] composer onChange handler failed:', error)
      }
    }
  })
}

export function registerComposer(next: ComposerController): () => void {
  controller = next
  notifyComposerChanged()
  return () => {
    if (controller !== next) return
    controller = null
    notifyComposerChanged()
  }
}

function mountedController(): ComposerController {
  if (!controller) throw new Error('COMPOSER_UNAVAILABLE: No chat composer is mounted')
  return controller
}

function assertText(text: unknown, member: string): asserts text is string {
  if (typeof text !== 'string') throw new TypeError(`${member} expects a string`)
}

export interface FrontendComposerDependencies {
  assertActive(): void
  requirePermission(permission: string, member: string): void
  onTeardown(handler: () => void): () => void
}

export function createFrontendComposerAPI(deps: FrontendComposerDependencies): SpindleComposerAPI {
  const subscriptions = new Set<() => void>()
  deps.onTeardown(() => {
    for (const unsubscribe of [...subscriptions]) unsubscribe()
  })

  return Object.freeze({
    getState() {
      deps.assertActive()
      return readState()
    },
    onChange(handler: (state: SpindleComposerState) => void) {
      deps.assertActive()
      if (typeof handler !== 'function') throw new TypeError('ctx.composer.onChange expects a function')
      const listener = (state: SpindleComposerState) => handler(state)
      listeners.add(listener)
      const unsubscribe = () => {
        listeners.delete(listener)
        subscriptions.delete(unsubscribe)
      }
      subscriptions.add(unsubscribe)
      return unsubscribe
    },
    setText(text: string) {
      deps.assertActive()
      assertText(text, 'ctx.composer.setText')
      mountedController().setText(text)
    },
    insertText(text: string, options?: { at?: SpindleComposerInsertPosition }) {
      deps.assertActive()
      assertText(text, 'ctx.composer.insertText')
      const at = options?.at ?? 'caret'
      if (at !== 'caret' && at !== 'end') throw new TypeError('ctx.composer.insertText: at must be "caret" or "end"')
      mountedController().insertText(text, at)
    },
    focus() {
      deps.assertActive()
      mountedController().focus()
    },
    async send() {
      deps.requirePermission('generation', 'ctx.composer.send')
      await mountedController().send()
    },
  })
}
