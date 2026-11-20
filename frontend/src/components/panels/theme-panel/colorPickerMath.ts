const SATURATION_EDGE_SNAP_PX = 4

export interface PickerRect {
  left: number
  top: number
  width: number
  height: number
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

export function getSaturationValueFromPoint(
  clientX: number,
  clientY: number,
  rect: PickerRect,
): { saturation: number; value: number } {
  const width = Math.max(1, rect.width)
  const height = Math.max(1, rect.height)
  const localX = clientX - rect.left
  const localY = clientY - rect.top
  const snapPx = Math.min(SATURATION_EDGE_SNAP_PX, width * 0.02)

  let x = clamp01(localX / width)
  if (localX <= snapPx) x = 0
  else if (localX >= width - snapPx) x = 1

  const y = clamp01(localY / height)

  return {
    saturation: x * 100,
    value: (1 - y) * 100,
  }
}
