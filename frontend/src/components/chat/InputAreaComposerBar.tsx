import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  createPointerHoldController,
  nextToolbarIconOrder,
  toolbarActionIdFromTarget,
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
  const [draggingActionId, setDraggingActionId] = useState<string | null>(null)
  const orderRef = useRef(order)
  orderRef.current = order
  const reorderRef = useRef(reorder)
  reorderRef.current = reorder

  const itemHoldRef = useRef<ReturnType<typeof createPointerHoldController> | null>(null)
  if (itemHoldRef.current === null) {
    itemHoldRef.current = createPointerHoldController(() => {
      const id = itemPendingIdRef.current
      if (!id) return
      itemDraggingIdRef.current = id
      eventSuppressClickRef.current = true
      setDraggingActionId(id)
    })
  }

  useEffect(() => () => {
    itemHoldRef.current?.cancel()
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

  const endItemReorder = () => {
    itemHoldRef.current?.cancel()
    itemPendingIdRef.current = null
    itemDraggingIdRef.current = null
    setDraggingActionId(null)
  }

  return (
    <div
      className={styles.actionBar}
      onPointerDown={(event) => {
        const itemId = toolbarActionIdFromTarget(event.target)
        if (!itemId || !enableReorder) return
        itemPendingIdRef.current = itemId
        itemHoldRef.current?.start(event)
      }}
      onPointerMove={(event) => {
        itemHoldRef.current?.move(event)
        applyItemReorderFromPointer(event)
      }}
      onPointerUp={() => {
        const itemHeld = itemHoldRef.current?.finish()
        if (itemHeld?.held) eventSuppressClickRef.current = true
        itemPendingIdRef.current = null
        itemDraggingIdRef.current = null
        setDraggingActionId(null)
      }}
      onPointerCancel={() => {
        endItemReorder()
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
