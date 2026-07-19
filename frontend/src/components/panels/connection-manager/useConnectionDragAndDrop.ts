import { useRef, useCallback } from 'react'
import {
  MouseSensor,
  TouchSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type Modifier,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'

export function useConnectionSensors() {
  const mouseSensor = useSensor(MouseSensor, { activationConstraint: { distance: 4 } })
  const touchSensor = useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  const keyboardSensor = useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  return useSensors(mouseSensor, touchSensor, keyboardSensor)
}

export function useVerticalSortModifier(listRef: React.RefObject<HTMLDivElement | null>) {
  return useCallback<Modifier>(({ transform, activeNodeRect }) => {
    if (!activeNodeRect || !listRef.current) return { ...transform, x: 0 }
    const rect = listRef.current.getBoundingClientRect()
    const activeTop = activeNodeRect.top + transform.y
    const activeBottom = activeNodeRect.bottom + transform.y
    let clampedY = transform.y
    if (activeTop < rect.top) clampedY += rect.top - activeTop
    if (activeBottom > rect.bottom) clampedY -= activeBottom - rect.bottom
    return { ...transform, x: 0, y: clampedY }
  }, [listRef])
}
