import type { Transform } from '@dnd-kit/utilities'
import { useSortable, type UseSortableArguments } from '@dnd-kit/sortable'
import { DndContext as BaseDndContext, getClientRect, useDndContext, type DndContextProps } from '@dnd-kit/core'
import { createElement, useCallback, useLayoutEffect, useRef } from 'react'
import { getUiScale } from './uiScale'

const computedTransformIncludesZoom = new WeakMap<Document, boolean>()

function transformTranslationScale(element: HTMLElement, uiScale: number): number {
  const doc = element.ownerDocument
  let includesZoom = computedTransformIncludesZoom.get(doc)
  if (includesZoom === undefined) {
    // Firefox currently serializes zoomed matrix translations; Chromium and
    // WebKit serialize layout pixels. Feature-detect once, outside body so
    // the user's current scale does not influence this fixed 2x probe.
    const probe = doc.createElement('div')
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;width:1px;height:1px;zoom:2;transform:translateX(1px)'
    doc.documentElement.appendChild(probe)
    try {
      includesZoom = new DOMMatrixReadOnly(getComputedStyle(probe).transform).m41 > 1.5
      computedTransformIncludesZoom.set(doc, includesZoom)
    } finally {
      probe.remove()
    }
  }
  const nativeZoom = includesZoom ? Number.parseFloat(getComputedStyle(doc.body).zoom) || 1 : 1
  return uiScale / nativeZoom
}

/** dnd-kit's default inverse transform mixes rendered rects with layout lengths. */
export function measureUiScaledRect(element: HTMLElement) {
  const scale = getUiScale()
  if (scale === 1) return getClientRect(element, { ignoreTransform: true })

  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  if (!style.transform || style.transform === 'none') {
    const { left, top, width, height, right, bottom } = rect
    return { left, top, width, height, right, bottom }
  }

  const matrix = new DOMMatrixReadOnly(style.transform)
  const [originX, originY] = style.transformOrigin.split(' ').map(Number.parseFloat)
  // Normalize matrix translations before removing the element's transform.
  // The origin remains in layout pixels in all engines. Body transforms on
  // Linux also need this conversion even though native CSS zoom is 1.
  const translationScale = transformTranslationScale(element, scale)
  const left = rect.left - matrix.m41 * translationScale - (1 - matrix.m11) * originX * scale
  const top = rect.top - matrix.m42 * translationScale - (1 - matrix.m22) * originY * scale
  const width = matrix.m11 ? rect.width / matrix.m11 : rect.width
  const height = matrix.m22 ? rect.height / matrix.m22 : rect.height
  return { left, top, width, height, right: left + width, bottom: top + height }
}

const scaledMeasuring = {
  draggable: { measure: measureUiScaledRect },
  droppable: { measure: measureUiScaledRect },
}

/** Shared sortable row geometry, used by lists and folder containers alike. */
export function useScaledSortable(options: UseSortableArguments) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable(options)
  return { attributes, listeners, isDragging, ...useScaledSortableStyle({ setNodeRef, transform, transition, isDragging }) }
}

/** Use with useScaledSortableStyle so measurement and painting share units. */
export function DndContext({ measuring, ...props }: DndContextProps) {
  return createElement(BaseDndContext, {
    ...props,
    measuring: measuring ? {
      ...measuring,
      draggable: { ...scaledMeasuring.draggable, ...measuring.draggable },
      droppable: { ...scaledMeasuring.droppable, ...measuring.droppable },
    } : scaledMeasuring,
  })
}

/**
 * Preserve intrinsic dimensions throughout sorting and the drop animation.
 * Target-size and derived FLIP scales can stretch variable-height rows,
 * including siblings that are no longer marked as dragging. Retain fractional
 * layout pixels rather than rounding them before the browser applies UI scale.
 */
function scaledTransform(transform: Transform | null): string | undefined {
  if (!transform) return undefined
  const uiScale = getUiScale()
  return `translate3d(${transform.x / uiScale}px, ${transform.y / uiScale}px, 0)`
}

interface ScaledSortableArgs {
  setNodeRef: (element: HTMLElement | null) => void
  transform: Transform | null
  transition?: string
  isDragging: boolean
}

/**
 * Wraps a `useSortable` result so the dragged row tracks the cursor correctly
 * regardless of UI scale or how far the list auto-scrolls. Returns a node ref to
 * spread onto the sortable element and the `style` (transform + transition).
 *
 * The active row uses viewport geometry throughout. dnd-kit's final transform
 * mixes viewport pointer deltas with layout scroll offsets, and its scroll
 * baseline can reset when the active rect is measured. Comparing the measured
 * rect with the row's current untransformed rect accounts for all scrolling
 * and layout shifts without depending on those internal scroll offsets.
 */
export function useScaledSortableStyle({
  setNodeRef,
  transform,
  transition,
  isDragging,
}: ScaledSortableArgs): {
  setNodeRef: (element: HTMLElement | null) => void
  style: { transition: string | undefined }
} {
  const nodeRef = useRef<HTMLElement | null>(null)
  const { active, dragOverlay: { rect: overlayRect } } = useDndContext()

  const ref = useCallback(
    (element: HTMLElement | null) => {
      nodeRef.current = element
      setNodeRef(element)
    },
    [setNodeRef],
  )

  useLayoutEffect(() => {
    const node = nodeRef.current
    if (!node) return
    const updateTransform = () => {
      let viewportTransform = transform
      // dnd-kit updates this rect after committing its context. Reading it here
      // keeps DOM measurement and mutable refs out of React's render phase.
      const target = active?.rect.current.translated
      if (isDragging && target && !overlayRect) {
        const current = measureUiScaledRect(node)
        viewportTransform = {
          x: target.left - current.left,
          y: target.top - current.top,
          scaleX: 1, scaleY: 1,
        }
      }
      node.style.transform = scaledTransform(viewportTransform) ?? ''
    }
    // The parent DndContext commits its rect after the child layout effect.
    // Update before the next paint once that rect is available.
    const doc = node.ownerDocument
    const view = doc.defaultView
    const frame = view?.requestAnimationFrame?.(updateTransform)
    if (frame === undefined) updateTransform()
    const cancelFrame = () => { if (frame !== undefined) view?.cancelAnimationFrame(frame) }
    if (!isDragging) return cancelFrame
    doc.addEventListener('scroll', updateTransform, { capture: true, passive: true })
    return () => {
      cancelFrame()
      doc.removeEventListener('scroll', updateTransform, true)
    }
  }, [active, isDragging, overlayRect, transform])

  return { setNodeRef: ref, style: { transition } }
}
