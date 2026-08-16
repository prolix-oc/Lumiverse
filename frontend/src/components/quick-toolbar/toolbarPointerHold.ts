import { QUICK_TOOLBAR_POINTER_HOLD_MS } from './quickToolbarDock'

export interface PointerHoldController {
  start: (event: { clientX: number; clientY: number }) => void
  move: (event: { clientX: number; clientY: number }) => void
  cancel: () => void
  finish: () => { held: boolean; clientX: number; clientY: number }
  isHeld: () => boolean
}

export function createPointerHoldController(
  onHold: (point: { clientX: number; clientY: number }) => void,
  holdMs = QUICK_TOOLBAR_POINTER_HOLD_MS,
): PointerHoldController {
  let timer: ReturnType<typeof setTimeout> | null = null
  let held = false
  let point = { clientX: 0, clientY: 0 }

  const clearTimer = () => {
    if (timer == null) return
    clearTimeout(timer)
    timer = null
  }

  const start = (event: { clientX: number; clientY: number }) => {
    clearTimer()
    held = false
    point = { clientX: event.clientX, clientY: event.clientY }
    timer = setTimeout(() => {
      timer = null
      held = true
      onHold(point)
    }, holdMs)
  }

  const move = (event: { clientX: number; clientY: number }) => {
    point = { clientX: event.clientX, clientY: event.clientY }
  }

  const cancel = () => {
    clearTimer()
    held = false
  }

  const finish = () => {
    const result = { held, clientX: point.clientX, clientY: point.clientY }
    clearTimer()
    return result
  }

  return { start, move, cancel, finish, isHeld: () => held }
}

export function isExplicitToolbarDragTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return Boolean(target.closest('[data-toolbar-drag-handle], [data-toolbar-resize-handle]'))
}
