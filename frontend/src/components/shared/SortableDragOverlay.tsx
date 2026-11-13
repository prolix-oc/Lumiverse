import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { DragOverlay } from '@dnd-kit/core'
import { getUiScale } from '@/lib/uiScale'

/** Lifted from the Lorebook list: a drawer must not contain a fixed drag preview. */
export default function SortableDragOverlay({ children, className }: {
  children: ReactNode
  className?: string
}) {
  const scale = getUiScale()
  return createPortal(
    <DragOverlay dropAnimation={null} zIndex={10010} style={{ zoom: 1 / scale }}>
      {children && <div className={className} aria-hidden="true" inert style={{ zoom: scale }}>
        {children}
      </div>}
    </DragOverlay>,
    document.body,
  )
}
