import { installExpandedEditorCaretReveal } from './expandedEditorCaret'

const textMetrics = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'word-spacing', 'text-indent', 'text-align',
  'text-transform', 'direction', 'tab-size', 'padding-top', 'padding-bottom',
  'padding-left', 'padding-right', 'border-top-width', 'border-bottom-width',
  'border-left-width', 'border-right-width', 'border-style',
] as const

export function findKeyboardScrollContainer(target: HTMLElement): HTMLElement | null {
  let container = target.parentElement
  while (container && container !== document.body && container !== document.documentElement) {
    const { overflowY } = getComputedStyle(container)
    if (overflowY === 'auto' || overflowY === 'scroll') return container
    container = container.parentElement
  }
  return null
}

/** A passive measurement surface; the textarea keeps native focus and selection. */
export function installTextareaKeyboardReveal(textarea: HTMLTextAreaElement): () => void {
  const mirror = document.createElement('div')
  mirror.setAttribute('aria-hidden', 'true')
  mirror.setAttribute('data-keyboard-caret-mirror', '')
  mirror.inert = true
  mirror.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;overflow:hidden;box-sizing:border-box;margin:0;min-height:0;max-height:none;min-width:0;max-width:none;'
  textarea.parentElement?.append(mirror)

  const prepare = () => {
    const style = getComputedStyle(textarea)
    for (const metric of textMetrics) mirror.style.setProperty(metric, style.getPropertyValue(metric))
    mirror.style.whiteSpace = textarea.wrap === 'off' ? 'pre' : 'pre-wrap'
    mirror.style.overflowWrap = textarea.wrap === 'off' ? 'normal' : 'break-word'
    // Match the native text width, including classic scrollbar space. The
    // mirror needs no scrollbar of its own and can scroll while hidden.
    const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
    mirror.style.width = `${textarea.clientWidth + (borders || 0)}px`
    mirror.style.height = `${textarea.offsetHeight}px`
    mirror.style.top = '0px'
    mirror.style.left = '0px'
    const rect = textarea.getBoundingClientRect()
    const origin = mirror.getBoundingClientRect()
    const scale = textarea.offsetHeight > 0 ? rect.height / textarea.offsetHeight : 1
    if (scale > 0) {
      // Fixed containing blocks (PWA body transforms, panel containment) and
      // UI zoom can both change the mirror's coordinate system.
      mirror.style.top = `${(rect.top - origin.top) / scale}px`
      mirror.style.left = `${(rect.left - origin.left) / scale}px`
    }
    const text = `${textarea.value}\u200b`
    if (mirror.textContent !== text) mirror.textContent = text
  }

  const stop = installExpandedEditorCaretReveal(textarea, mirror, {
    prepare,
    getScrollContainer: () => findKeyboardScrollContainer(textarea),
  })
  return () => { stop(); mirror.remove() }
}
