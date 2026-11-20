export interface SnapRangeValueOptions {
  min: number
  max: number
  step?: number
  integer?: boolean
}

export function snapRangeValue(
  raw: number,
  { min, max, step = 1, integer = false }: SnapRangeValueOptions,
): number {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1
  const clamped = Math.min(max, Math.max(min, raw))
  const stepped = Math.round((clamped - min) / safeStep) * safeStep + min
  const snapped = Math.min(max, Math.max(min, stepped))

  if (integer) return Math.round(snapped)

  const decimals = (String(safeStep).split('.')[1] || '').length
  return decimals > 0 ? parseFloat(snapped.toFixed(decimals)) : snapped
}

export type NumericRange = readonly [number, number]

export function snapNumericRange(
  value: NumericRange,
  options: SnapRangeValueOptions,
): [number, number] {
  const first = snapRangeValue(value[0], options)
  const second = snapRangeValue(value[1], options)
  return first <= second ? [first, second] : [second, first]
}

export function updateNumericRange(
  value: NumericRange,
  handle: 0 | 1,
  raw: number,
  options: SnapRangeValueOptions,
): [number, number] {
  const current = snapNumericRange(value, options)
  const next = snapRangeValue(raw, options)
  return handle === 0
    ? [Math.min(next, current[1]), current[1]]
    : [current[0], Math.max(next, current[0])]
}

export function nearestNumericRangeHandle(value: NumericRange, raw: number): 0 | 1 {
  const startDistance = Math.abs(raw - value[0])
  const endDistance = Math.abs(raw - value[1])
  if (startDistance === endDistance) return raw < value[0] ? 0 : 1
  return startDistance < endDistance ? 0 : 1
}
