import type { DeviceAttitudeQuaternion as Quaternion, DeviceOrientationReading, DeviceRotationSnapshot } from './deviceRotation'

const radians = Math.PI / 180
// A soft limit keeps responding past an ordinary wrist tilt instead of hitting
// a hard stop at ten degrees. Horizontal motion gets the wider travel range.
const horizontalRange = 24 * radians
const verticalRange = 16 * radians

function multiply(a: Quaternion, b: Quaternion): Quaternion {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  }
}

/** DeviceOrientation uses intrinsic Z-X-Y rotations, not Core Motion Euler angles. */
export function orientationQuaternion(reading: DeviceOrientationReading): Quaternion | null {
  if (reading.beta === null || reading.gamma === null) return null
  const a = (reading.alpha ?? 0) * radians / 2, b = reading.beta * radians / 2, g = reading.gamma * radians / 2
  return multiply(multiply(
    { x: 0, y: 0, z: Math.sin(a), w: Math.cos(a) },
    { x: Math.sin(b), y: 0, z: 0, w: Math.cos(b) },
  ), { x: 0, y: Math.sin(g), z: 0, w: Math.cos(g) })
}

export function deviceScreenAngle(): number {
  return window.screen?.orientation?.angle ?? (window as Window & { orientation?: number }).orientation ?? 0
}

/** Calibrate at the current grip and measure rotation around the screen's axes. */
export function createRelativeDeviceTilt() {
  let baseline: Quaternion | null = null
  let previousAngle: number | null = null
  let previousReference: number | undefined
  return (snapshot: DeviceRotationSnapshot, screenAngle: number): { x: number; y: number } | null => {
    const q = snapshot.quaternion ?? (snapshot.orientation ? orientationQuaternion(snapshot.orientation) : null)
    if (!q) return null
    if (screenAngle !== previousAngle || snapshot.reference !== previousReference) baseline = null
    previousAngle = screenAngle
    previousReference = snapshot.reference
    baseline ??= q
    // Express the change in the original device axes. This stays continuous at
    // upright beta=90 degrees and across equivalent Euler representations.
    const delta = multiply({ x: -baseline.x, y: -baseline.y, z: -baseline.z, w: baseline.w }, q)
    const sign = delta.w < 0 ? -1 : 1 // q and -q describe the same orientation
    const length = Math.hypot(delta.x, delta.y, delta.z)
    const scale = length < 1e-8 ? 2 : 2 * Math.atan2(length, Math.abs(delta.w)) / length
    const rx = delta.x * sign * scale, ry = delta.y * sign * scale
    const angle = screenAngle * radians
    // Screen angle is counterclockwise from portrait. Map first so sensitivity
    // follows the visible card axes in both portrait and landscape.
    return {
      x: Math.tanh((ry * Math.cos(angle) + rx * Math.sin(angle)) / horizontalRange),
      y: Math.tanh((rx * Math.cos(angle) - ry * Math.sin(angle)) / verticalRange),
    }
  }
}
