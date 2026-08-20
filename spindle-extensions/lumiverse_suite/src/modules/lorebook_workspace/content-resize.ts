import type { ScopedHostRoot } from '../../shared/public-sdk'
import { ownerDocumentOf } from '../../shared/public-sdk'

const CONTENT_TEXTAREA_SELECTOR = '[data-world-book-entry-editor="true"][data-density="compact"] [data-world-book-identity-content="true"] [data-content-flex-region="true"] textarea'

interface ContentResizeTrackingOptions {
  readonly ResizeObserver?: typeof ResizeObserver
  readonly MutationObserver?: typeof MutationObserver
  readonly layoutElementRect?: (element: Element) => { readonly height: number }
}

interface TrackedTextarea {
  observer: ResizeObserver
  readonly applyHeight: (height: number) => void
  readonly section: HTMLElement
  readonly field: HTMLElement
  readonly wrapper: HTMLElement
  readonly previous: {
    sectionFlex: string
    sectionUserSized: string | undefined
    fieldFlex: string
    fieldMinHeight: string
    wrapperFlex: string
    wrapperHeight: string
    wrapperMinHeight: string
  }
  userSized: boolean
}

function observedBlockSize(entry: ResizeObserverEntry): number {
  const borderBox = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry.borderBoxSize
  return borderBox?.blockSize ?? entry.contentRect.height
}

function restoreTrackedTextarea(tracked: TrackedTextarea): void {
  tracked.observer.disconnect()
  tracked.section.style.flex = tracked.previous.sectionFlex
  if (tracked.previous.sectionUserSized === undefined) {
    delete tracked.section.dataset.contentUserSized
  } else {
    tracked.section.dataset.contentUserSized = tracked.previous.sectionUserSized
  }
  tracked.field.style.flex = tracked.previous.fieldFlex
  tracked.field.style.minHeight = tracked.previous.fieldMinHeight
  tracked.wrapper.style.flex = tracked.previous.wrapperFlex
  tracked.wrapper.style.height = tracked.previous.wrapperHeight
  tracked.wrapper.style.minHeight = tracked.previous.wrapperMinHeight
}

function ancestorMatching(start: HTMLElement, predicate: (node: HTMLElement) => boolean): HTMLElement | undefined {
  let current: HTMLElement | null = start
  while (current) {
    if (predicate(current)) return current
    current = current.parentElement
  }
  return undefined
}

export function installLorebookContentResizeTracking(
  root: ScopedHostRoot,
  options: ContentResizeTrackingOptions = {},
): () => void {
  const view = ownerDocumentOf(root)?.defaultView
  const ResizeObserverConstructor = options.ResizeObserver ?? view?.ResizeObserver
  const MutationObserverConstructor = options.MutationObserver ?? view?.MutationObserver
  const layoutElementRect = options.layoutElementRect
  if (!ResizeObserverConstructor || !MutationObserverConstructor) return () => undefined

  const tracked = new Map<HTMLTextAreaElement, TrackedTextarea>()
  let scanScheduled = false
  let disposed = false

  const elementHeight = (element: Element): number => {
    const hostHeight = layoutElementRect?.(element).height
    if (typeof hostHeight === 'number' && Number.isFinite(hostHeight) && hostHeight > 0) return hostHeight
    const rendered = element as HTMLElement
    // lumiverse-geometry-justification: textarea measurement fallback when host layoutElementRect is unavailable
    return typeof rendered.offsetHeight === 'number' ? rendered.offsetHeight : 0
  }

  const textareaHeight = (textarea: HTMLTextAreaElement): number => {
    const inlineHeight = Number.parseFloat(textarea.style.height)
    return Number.isFinite(inlineHeight) && inlineHeight > 0
      ? inlineHeight
      : elementHeight(textarea)
  }

  const track = (textarea: HTMLTextAreaElement): void => {
    if (tracked.has(textarea)) return
    const section = ancestorMatching(textarea, node => node.dataset.worldBookIdentityContent === 'true')
    const field = ancestorMatching(textarea, node => node.dataset.contentFlexRegion === 'true')
    const wrapper = textarea.parentElement
    if (!section || !field || !wrapper) return

    let trackedTextarea: TrackedTextarea
    const applyHeight = (height: number): void => {
      if (!Number.isFinite(height) || height <= 0) return
      const wrapperHeight = elementHeight(wrapper)
      if (!trackedTextarea.userSized && Math.abs(height - wrapperHeight) <= 1) return

      trackedTextarea.userSized = true
      section.dataset.contentUserSized = 'true'
      section.style.flex = '0 0 auto'
      field.style.flex = '0 0 auto'
      field.style.minHeight = '0px'
      wrapper.style.flex = `0 0 ${height}px`
      wrapper.style.height = `${height}px`
      wrapper.style.minHeight = '0px'
    }
    const observer = new ResizeObserverConstructor((entries) => {
      for (const entry of entries) {
        if (entry.target !== textarea) continue
        applyHeight(observedBlockSize(entry))
      }
    })
    trackedTextarea = {
      observer,
      applyHeight,
      section,
      field,
      wrapper,
      previous: {
        sectionFlex: section.style.flex,
        sectionUserSized: section.dataset.contentUserSized,
        fieldFlex: field.style.flex,
        fieldMinHeight: field.style.minHeight,
        wrapperFlex: wrapper.style.flex,
        wrapperHeight: wrapper.style.height,
        wrapperMinHeight: wrapper.style.minHeight,
      },
      userSized: false,
    }
    tracked.set(textarea, trackedTextarea)
    observer.observe(textarea)
    if (textarea.style.height) applyHeight(textareaHeight(textarea))
  }

  const scan = (): void => {
    scanScheduled = false
    if (disposed) return
    const active = new Set(
      root.querySelectorAll<HTMLTextAreaElement>(CONTENT_TEXTAREA_SELECTOR),
    )
    for (const textarea of active) track(textarea)
    for (const [textarea, trackedTextarea] of tracked) {
      if (active.has(textarea)) continue
      restoreTrackedTextarea(trackedTextarea)
      tracked.delete(textarea)
    }
  }

  const scheduleScan = (): void => {
    if (scanScheduled || disposed) return
    scanScheduled = true
    queueMicrotask(scan)
  }

  const mutationObserver = new MutationObserverConstructor((records) => {
    for (const record of records) {
      if (record.type === 'childList') {
        scheduleScan()
        continue
      }
      const textarea = record.target as HTMLTextAreaElement
      const trackedTextarea = tracked.get(textarea)
      if (!trackedTextarea || textarea.tagName !== 'TEXTAREA') continue
      trackedTextarea.applyHeight(textareaHeight(textarea))
    }
  })
  mutationObserver.observe(root, {
    attributes: true,
    attributeFilter: ['style'],
    childList: true,
    subtree: true,
  })
  scan()

  return () => {
    if (disposed) return
    disposed = true
    mutationObserver.disconnect()
    for (const [, trackedTextarea] of tracked) {
      restoreTrackedTextarea(trackedTextarea)
    }
    tracked.clear()
  }
}
