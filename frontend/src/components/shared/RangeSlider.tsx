import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import styles from './RangeSlider.module.css'

export interface RangeSliderProps {
  min: number
  max: number
  step?: number
  /** Round to integers regardless of step formatting. */
  integer?: boolean
  /** Committed value (the source of truth from the parent). */
  value: number
  /** Called once when a drag ends with a new value. */
  onCommit: (val: number) => void
  /**
   * Optional. Called with the live drag value during a gesture, and with
   * `null` if the gesture ended without committing (e.g. touchcancel without
   * movement). Use this to mirror the live value into a sibling label/input.
   */
  onDragValue?: (val: number | null) => void
  disabled?: boolean
  className?: string
}

/**
 * Bare slider track with horizontal drag. Touch input uses native event
 * listeners with direction detection so vertical scroll attempts pass
 * through to the page, and mid-drag pointercancel (common on iOS) does not
 * kill the gesture. Mouse/pen input uses React pointer events.
 */
export function RangeSlider({
  min,
  max,
  step = 1,
  integer = false,
  value,
  onCommit,
  onDragValue,
  disabled = false,
  className,
}: RangeSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragValueRef = useRef<number | null>(null)
  const movedRef = useRef(false)

  const [localValue, setLocalValue] = useState<number | null>(null)
  const currentValue = localValue !== null ? localValue : value
  const pct = max === min ? 0 : Math.min(100, Math.max(0, ((currentValue - min) / (max - min)) * 100))

  const snap = useCallback(
    (raw: number) => {
      const clamped = Math.min(max, Math.max(min, raw))
      const stepped = Math.round((clamped - min) / step) * step + min
      if (integer) return Math.round(stepped)
      const decimals = (String(step).split('.')[1] || '').length
      return decimals > 0 ? parseFloat(stepped.toFixed(decimals)) : stepped
    },
    [min, max, step, integer],
  )

  const posToValue = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || rect.width === 0) return currentValue
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      return snap(min + ratio * (max - min))
    },
    [min, max, snap, currentValue],
  )

  // Stable refs for the native touch listeners (attached once via useEffect).
  const posToValueRef = useRef(posToValue)
  posToValueRef.current = posToValue
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const onDragValueRef = useRef(onDragValue)
  onDragValueRef.current = onDragValue

  // ── Mouse / pen path ──
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return
      if (e.pointerType === 'touch') return
      e.preventDefault()
      dragging.current = true
      movedRef.current = false
      trackRef.current?.setPointerCapture(e.pointerId)
      const val = posToValue(e.clientX)
      dragValueRef.current = val
      setLocalValue(val)
      onDragValue?.(val)
    },
    [posToValue, onDragValue, disabled],
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (!dragging.current) return
      movedRef.current = true
      const val = posToValue(e.clientX)
      dragValueRef.current = val
      setLocalValue(val)
      onDragValue?.(val)
    },
    [posToValue, onDragValue],
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (!dragging.current) return
      dragging.current = false
      trackRef.current?.releasePointerCapture(e.pointerId)
      const final = dragValueRef.current
      dragValueRef.current = null
      movedRef.current = false
      setLocalValue(null)
      if (final !== null) onCommit(final)
    },
    [onCommit],
  )

  const handlePointerCancel = useCallback(
    (e: React.PointerEvent) => {
      if (e.pointerType === 'touch') return
      if (!dragging.current) return
      dragging.current = false
      trackRef.current?.releasePointerCapture(e.pointerId)
      dragValueRef.current = null
      movedRef.current = false
      setLocalValue(null)
      onDragValue?.(null)
    },
    [onDragValue],
  )

  // ── Touch path ──
  // iOS fires pointercancel mid-drag for various reasons (scroll heuristics,
  // multi-touch, system gestures), after which pointer events never resume
  // on the element. Native touch events keep firing through all of that, so
  // touch input lives entirely outside React's synthetic pointer system.
  useEffect(() => {
    const track = trackRef.current
    if (!track || disabled) return

    const THRESHOLD = 6
    let startX = 0
    let startY = 0
    let active = false
    let direction: 'horizontal' | 'vertical' | null = null

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return
      const t = e.touches[0]
      startX = t.clientX
      startY = t.clientY
      active = true
      direction = null
      dragging.current = false
      movedRef.current = false
    }

    const onTouchMove = (e: TouchEvent) => {
      if (!active) return
      const t = e.touches[0]
      if (!t) return

      if (direction === null) {
        const dx = Math.abs(t.clientX - startX)
        const dy = Math.abs(t.clientY - startY)
        if (dx + dy < THRESHOLD) return
        if (dy > dx) {
          direction = 'vertical'
          active = false
          return
        }
        direction = 'horizontal'
        dragging.current = true
        const startVal = posToValueRef.current(startX)
        dragValueRef.current = startVal
        setLocalValue(startVal)
        onDragValueRef.current?.(startVal)
      }

      if (direction === 'horizontal') {
        // Non-passive listener — claims the gesture from the browser. Even
        // if the pointer-event channel cancels, touch events continue.
        e.preventDefault()
        movedRef.current = true
        const val = posToValueRef.current(t.clientX)
        dragValueRef.current = val
        setLocalValue(val)
        onDragValueRef.current?.(val)
      }
    }

    const onTouchEnd = (e: TouchEvent) => {
      const wasHorizontal = direction === 'horizontal' && dragging.current
      const wasTap = direction === null && active
      const final = dragValueRef.current
      dragging.current = false
      dragValueRef.current = null
      movedRef.current = false
      active = false
      direction = null
      setLocalValue(null)

      if (wasHorizontal && final !== null) {
        onCommitRef.current(final)
      } else if (wasTap) {
        const t = e.changedTouches[0]
        if (t) onCommitRef.current(posToValueRef.current(t.clientX))
      }
    }

    const onTouchCancel = () => {
      const wasHorizontal = direction === 'horizontal' && dragging.current
      const moved = movedRef.current
      const final = dragValueRef.current
      dragging.current = false
      dragValueRef.current = null
      movedRef.current = false
      active = false
      direction = null
      setLocalValue(null)

      if (wasHorizontal && moved && final !== null) {
        onCommitRef.current(final)
      } else {
        onDragValueRef.current?.(null)
      }
    }

    track.addEventListener('touchstart', onTouchStart, { passive: false })
    track.addEventListener('touchmove', onTouchMove, { passive: false })
    track.addEventListener('touchend', onTouchEnd)
    track.addEventListener('touchcancel', onTouchCancel)
    return () => {
      track.removeEventListener('touchstart', onTouchStart)
      track.removeEventListener('touchmove', onTouchMove)
      track.removeEventListener('touchend', onTouchEnd)
      track.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [disabled])

  return (
    <div
      ref={trackRef}
      className={clsx(styles.trackArea, disabled && styles.disabled, className)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
    >
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${pct}%` }} />
        <div className={styles.thumb} style={{ left: `${pct}%` }} />
      </div>
    </div>
  )
}

export interface LabeledRangeSliderProps extends RangeSliderProps {
  label: string
  hint?: string
  /** Format the value for display (e.g. `(v) => v.toFixed(2)` or `(v) => `${v}ms``). */
  formatValue?: (val: number) => string
  rowClassName?: string
}

/**
 * RangeSlider with a header (label + live value) and optional hint.
 * The displayed value tracks the drag in real time and falls back to the
 * committed `value` prop when no drag is in progress.
 */
export function LabeledRangeSlider({
  label,
  hint,
  formatValue,
  rowClassName,
  onDragValue: consumerOnDragValue,
  ...rangeProps
}: LabeledRangeSliderProps) {
  const [liveValue, setLiveValue] = useState<number | null>(null)
  const displayValue = liveValue !== null ? liveValue : rangeProps.value
  const formatted = formatValue ? formatValue(displayValue) : String(displayValue)

  // Reset the in-flight drag value when the committed value updates, so a
  // post-commit re-render doesn't leave stale liveValue behind.
  useEffect(() => {
    setLiveValue(null)
  }, [rangeProps.value])

  const handleDragValue = useCallback(
    (val: number | null) => {
      setLiveValue(val)
      consumerOnDragValue?.(val)
    },
    [consumerOnDragValue],
  )

  return (
    <div className={clsx(styles.labeledRow, rowClassName)}>
      <div className={styles.labeledHeader}>
        <span className={styles.labeledLabel}>{label}</span>
        <span className={styles.labeledValue}>{formatted}</span>
      </div>
      {hint && <div className={styles.labeledHint}>{hint}</div>}
      <RangeSlider {...rangeProps} onDragValue={handleDragValue} />
    </div>
  )
}
