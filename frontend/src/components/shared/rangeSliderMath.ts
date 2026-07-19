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
