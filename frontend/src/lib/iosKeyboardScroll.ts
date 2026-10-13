interface ComposerTouchEnd {
  currentTarget: HTMLTextAreaElement
  defaultPrevented: boolean
  cancelable: boolean
  touches: { length: number }
  changedTouches: { length: number }
  preventDefault(): void
}

interface ComposerTouchGesture extends ComposerTouchEnd {
  touches: ArrayLike<Pick<Touch, 'identifier' | 'clientX' | 'clientY'>>
  changedTouches: ArrayLike<Pick<Touch, 'identifier' | 'clientX' | 'clientY'>>
}

/** Only taps may open the keyboard; scrolling inside a draft must stay native. */
export function createComposerTouchFocusHandlers() {
  let start: { target: HTMLTextAreaElement; id: number; x: number; y: number } | null = null
  const moved = (touch: ComposerTouchGesture['touches'][number]) => !start ||
    touch.identifier !== start.id || Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10

  return {
    onTouchStart(event: ComposerTouchGesture) {
      const touch = event.touches[0]
      start = event.touches.length === 1 && touch
        ? { target: event.currentTarget, id: touch.identifier, x: touch.clientX, y: touch.clientY }
        : null
    },
    onTouchMove(event: ComposerTouchGesture) {
      const touch = event.touches[0]
      if (event.touches.length !== 1 || !touch || moved(touch)) start = null
    },
    onTouchEnd(event: ComposerTouchGesture) {
      const touch = event.changedTouches[0]
      const tapped = start?.target === event.currentTarget && touch && !moved(touch)
      start = null
      if (tapped) focusComposerOnTouchEnd(event)
    },
    onTouchCancel() { start = null },
  }
}

/** Own the first focus so WebKit does not pan the PWA to reveal the composer. */
export function focusComposerOnTouchEnd(event: ComposerTouchEnd): void {
  const target = event.currentTarget
  const document = target.ownerDocument
  if (!document.documentElement.hasAttribute('data-ios-pwa')) return
  if (event.defaultPrevented || !event.cancelable) return
  if (event.touches.length !== 0 || event.changedTouches.length !== 1) return
  // Once focused, native touches own caret placement, selection and paste.
  if (document.activeElement === target || target.disabled || target.readOnly) return

  event.preventDefault()
  // This must stay synchronous within the touch gesture to open the keyboard.
  // The composer already owns keyboard clearance through its bottom inset.
  target.focus({ preventScroll: true })
}

/** Recover real document scrolling without fighting visual-viewport panning. */
export function installIOSKeyboardScrollGuard(): () => void {
  const viewport = window.visualViewport
  const recover = () => {
    if (Math.abs((viewport?.scale ?? 1) - 1) > 0.01) return
    // offsetTop can be transient or stale while the document is already at
    // its origin. Repeated scrollTo calls there interrupt WebKit's keyboard
    // animation and can bounce the entire app in the opposite direction.
    if (window.scrollX === 0 && window.scrollY === 0) return
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' })
  }

  window.addEventListener('scroll', recover, { passive: true })
  viewport?.addEventListener('scroll', recover)
  return () => {
    window.removeEventListener('scroll', recover)
    viewport?.removeEventListener('scroll', recover)
  }
}
