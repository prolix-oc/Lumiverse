/**
 * Touch/pen long-press -> queue gesture for regex send-actions.
 *
 * The controller owns only the action-level gesture. Message-level long-press
 * menus are excluded separately by the message renderers using composedPath().
 *
 * Guards live at module scope so a consumed hold survives MessageContent
 * effect teardown/re-attachment after the draft is inserted.
 */

export interface RegexActionLongPressOptions {
  container: HTMLElement
  findTarget(event: Event): Element | null
  isQueueable(target: Element): boolean
  onQueue(target: Element): void
  longPressMs?: number
  movementSlopPx?: number
  graceWindowMs?: number
  maxHeldMs?: number
}

export interface RegexActionLongPressController {
  shouldSuppressEvent(event: Event, target: Element | null): boolean
  destroy(): void
}

type GuardPhase = 'pending' | 'consumed'

interface GestureGuard {
  owner: symbol
  phase: GuardPhase
  expiresAt: number
  graceWindowMs: number
}

const guards = new WeakMap<Element, GestureGuard>()

function activeGuard(target: Element): GestureGuard | null {
  const guard = guards.get(target)
  if (!guard) return null

  if (Date.now() > guard.expiresAt) {
    guards.delete(target)
    return null
  }

  return guard
}

export function attachRegexActionLongPress(
  options: RegexActionLongPressOptions,
): RegexActionLongPressController {
  const { container, findTarget, isQueueable, onQueue } = options
  const longPressMs = options.longPressMs ?? 500
  const movementSlopPx = options.movementSlopPx ?? 12
  const graceWindowMs = options.graceWindowMs ?? 750
  const maxHeldMs = options.maxHeldMs ?? 10_000
  const owner = Symbol('regex-action-long-press')

  let timer: ReturnType<typeof setTimeout> | null = null
  let pressTarget: Element | null = null
  let pressPointerId: number | null = null
  let pressOrigin: { x: number; y: number } | null = null
  let destroyed = false

  const pointerListeners: Array<[string, EventListener]> = []

  const detachPointerListeners = (): void => {
    for (const [type, handler] of pointerListeners) {
      container.removeEventListener(type, handler)
    }
    pointerListeners.length = 0
  }

  const resetLocal = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    detachPointerListeners()
    pressTarget = null
    pressPointerId = null
    pressOrigin = null
  }

  const clearPendingGuard = (target: Element | null): void => {
    if (!target) return
    const guard = guards.get(target)
    if (guard?.owner === owner && guard.phase === 'pending') {
      guards.delete(target)
    }
  }

  const cancelPending = (): void => {
    clearPendingGuard(pressTarget)
    resetLocal()
  }

  const handlePointerMove = (event: PointerEvent): void => {
    if (timer === null || pressOrigin === null || pressPointerId === null) return
    if (event.pointerId !== pressPointerId) return

    const dx = event.clientX - pressOrigin.x
    const dy = event.clientY - pressOrigin.y
    if (dx * dx + dy * dy > movementSlopPx * movementSlopPx) cancelPending()
  }

  const handlePointerUp = (event: PointerEvent): void => {
    if (pressPointerId === null || event.pointerId !== pressPointerId) return

    const target = pressTarget
    const guard = target ? activeGuard(target) : null

    if (guard?.owner === owner && guard.phase === 'consumed') {
      guard.expiresAt = Date.now() + graceWindowMs
      resetLocal()
      return
    }

    cancelPending()
  }

  const handlePointerCancel = (event: PointerEvent): void => {
    if (pressPointerId === null || event.pointerId !== pressPointerId) return

    const guard = pressTarget ? activeGuard(pressTarget) : null
    if (guard?.owner === owner && guard.phase === 'consumed') {
      // Mobile browsers may emit pointercancel while the finger is still held.
      // Keep the consumed guard alive until click/release evidence or timeout.
      return
    }

    cancelPending()
  }

  const handlePointerDown = (event: PointerEvent): void => {
    if (destroyed || event.pointerType === 'mouse' || event.isPrimary === false) return

    const target = findTarget(event)
    if (!target || !isQueueable(target)) return

    // A fresh primary press proves any stale hold on this action is over.
    guards.delete(target)
    cancelPending()

    pressTarget = target
    pressPointerId = event.pointerId
    pressOrigin = { x: event.clientX, y: event.clientY }

    guards.set(target, {
      owner,
      phase: 'pending',
      expiresAt: Date.now() + maxHeldMs,
      graceWindowMs,
    })

    pointerListeners.push(
      ['pointermove', handlePointerMove as EventListener],
      ['pointerup', handlePointerUp as EventListener],
      ['pointercancel', handlePointerCancel as EventListener],
    )
    for (const [type, handler] of pointerListeners) {
      container.addEventListener(type, handler)
    }

    timer = setTimeout(() => {
      timer = null

      const target = pressTarget
      if (!target || destroyed || !isQueueable(target)) {
        cancelPending()
        return
      }

      const guard = activeGuard(target)
      if (!guard || guard.owner !== owner || guard.phase !== 'pending') {
        cancelPending()
        return
      }

      guard.phase = 'consumed'
      guard.expiresAt = Date.now() + maxHeldMs
      onQueue(target)
    }, longPressMs)
  }

  container.addEventListener('pointerdown', handlePointerDown)

  return {
    shouldSuppressEvent(event: Event, target: Element | null): boolean {
      if (!target || (event.type !== 'click' && event.type !== 'contextmenu')) return false

      const guard = activeGuard(target)
      if (!guard) return false

      // While waiting for the hold timer, only contextmenu is ours. A quick
      // tap's click must still follow the normal send path.
      if (guard.phase === 'pending') return event.type === 'contextmenu'

      // A synthesized click can be the only release evidence after a browser
      // emits pointercancel during long-press recognition.
      if (event.type === 'click') {
        guard.expiresAt = Date.now() + guard.graceWindowMs
      }

      return true
    },

    destroy() {
      if (destroyed) return
      destroyed = true

      // Pending state belongs to this controller. Consumed state intentionally
      // survives teardown so the next MessageContent effect can suppress the
      // release click/contextmenu from the same physical hold.
      clearPendingGuard(pressTarget)
      resetLocal()
      container.removeEventListener('pointerdown', handlePointerDown)
    },
  }
}
