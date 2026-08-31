import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  createPointerHoldController,
  nextToolbarIconOrder,
  toolbarActionIdFromTarget,
  type PointerHoldController,
} from '@/components/quick-toolbar/toolbarPointerHold'
import styles from './InputArea.module.css'

export function ComposerActionBarLive({
  order,
  isVisible,
  reorder,
  enableReorder,
  renderUnit,
  children,
}: {
  order: string[]
  isVisible: (id: string) => boolean
  reorder: (ids: string[]) => void
  enableReorder: boolean
  renderUnit: (id: string) => ReactNode
  children?: ReactNode
}) {
  const eventSuppressClickRef = useRef(false)
  const itemPendingIdRef = useRef<string | null>(null)
  const itemDraggingIdRef = useRef<string | null>(null)
  const pointerIdRef = useRef<number | null>(null)
  const pointerCaptureTargetRef = useRef<HTMLDivElement | null>(null)
  const [draggingActionId, setDraggingActionId] = useState<string | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  const reorderRef = useRef(reorder)
  reorderRef.current = reorder

  const itemHoldRef = useRef<PointerHoldController | null>(null)
  if (itemHoldRef.current === null) {
    itemHoldRef.current = createPointerHoldController(() => {
      const id = itemPendingIdRef.current
      if (!id) return
      itemDraggingIdRef.current = id
      eventSuppressClickRef.current = true
      setDraggingActionId(id)
    })
  }

  const releasePointerCapture = () => {
    const pointerId = pointerIdRef.current
    const target = pointerCaptureTargetRef.current
    pointerIdRef.current = null
    pointerCaptureTargetRef.current = null
    if (pointerId === null || !target?.hasPointerCapture?.(pointerId)) return
    target.releasePointerCapture(pointerId)
  }

  useEffect(() => () => {
    itemHoldRef.current?.cancel()
    releasePointerCapture()
    itemPendingIdRef.current = null
    itemDraggingIdRef.current = null
  }, [])

  const applyItemReorderFromPointer = (event: { target: EventTarget | null; clientX: number; clientY: number }) => {
    const dragId = itemDraggingIdRef.current
    if (!dragId) return
    const overId = toolbarActionIdFromTarget(event.target)
      ?? toolbarActionIdFromTarget(document.elementFromPoint(event.clientX, event.clientY))
    if (!overId) return
    const next = nextToolbarIconOrder(orderRef.current, dragId, overId)
    if (!next) return
    reorderRef.current(next)
  }

  const finishItemReorder = (pointerId?: number) => {
    if (pointerId !== undefined && pointerIdRef.current !== pointerId) return
    const itemHeld = itemHoldRef.current?.finish()
    const wasDragging = itemDraggingIdRef.current !== null
    eventSuppressClickRef.current = Boolean(itemHeld?.held || wasDragging)
    itemPendingIdRef.current = null
    itemDraggingIdRef.current = null
    setDraggingActionId(null)
    releasePointerCapture()
  }

  const cancelItemReorder = (pointerId?: number) => {
    if (pointerId !== undefined && pointerIdRef.current !== pointerId) return
    itemHoldRef.current?.cancel()
    itemPendingIdRef.current = null
    itemDraggingIdRef.current = null
    setDraggingActionId(null)
    eventSuppressClickRef.current = false
    releasePointerCapture()
  }

  return (
    <div
      className={styles.actionBar}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-composer-customize]')) return
        const itemId = toolbarActionIdFromTarget(event.target)
        if (!itemId || !enableReorder) return
        if (pointerIdRef.current !== null) return
        eventSuppressClickRef.current = false
        itemPendingIdRef.current = itemId
        pointerIdRef.current = event.pointerId
        pointerCaptureTargetRef.current = event.currentTarget
        event.currentTarget.setPointerCapture?.(event.pointerId)
        itemHoldRef.current?.start(event)
      }}
      onPointerMove={(event) => {
        if (pointerIdRef.current !== null && event.pointerId !== pointerIdRef.current) return
        itemHoldRef.current?.move(event)
        applyItemReorderFromPointer(event)
      }}
      onPointerUp={(event) => {
        finishItemReorder(event.pointerId)
      }}
      onPointerCancel={(event) => {
        cancelItemReorder(event.pointerId)
      }}
      onLostPointerCapture={(event) => {
        finishItemReorder(event.pointerId)
      }}
      onClickCapture={(event) => {
        if (!eventSuppressClickRef.current) return
        eventSuppressClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      {order.map((id) => {
        if (!isVisible(id)) return null
        const unit = renderUnit(id)
        if (!unit) return null
        return (
          <span
            key={id}
            className={styles.composerReorderUnit}
            data-composer-action={id}
            data-toolbar-action={id}
            data-toolbar-item-drag-handle=""
            data-dragging={draggingActionId === id ? '' : undefined}
            style={{ display: 'contents' }}
          >
            {unit}
          </span>
        )
      })}
      {children}
    </div>
  )
}
