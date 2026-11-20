import { useRef, useEffect } from 'react'

export function useDragHandleBlur(isDragging: boolean) {
  const handleRef = useRef<HTMLButtonElement>(null)
  const wasDraggingRef = useRef(false)
  useEffect(() => {
    if (wasDraggingRef.current && !isDragging) {
      handleRef.current?.blur()
    }
    wasDraggingRef.current = isDragging
  }, [isDragging])
  return handleRef
}
