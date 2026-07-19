type PermissionRequestState = 'granted' | 'denied'

type PermissionCapableConstructor = {
  requestPermission?: (absolute?: boolean) => Promise<PermissionRequestState>
}

export type DeviceRotationPermissionState = PermissionState | 'unsupported' | 'unavailable' | 'unknown'

export interface DeviceRotationPermissionResult {
  state: DeviceRotationPermissionState
  requiresUserGesture: boolean
  reason?: string
}

export interface DeviceOrientationReading {
  /** Compass-style rotation around the z-axis, in degrees. */
  alpha: number | null
  /** Front-to-back tilt, in degrees. */
  beta: number | null
  /** Left-to-right tilt, in degrees. */
  gamma: number | null
  absolute: boolean
}

export interface DeviceRotationRateReading {
  /** Rotation rate around the z-axis, in degrees per second. */
  alpha: number | null
  /** Rotation rate around the x-axis, in degrees per second. */
  beta: number | null
  /** Rotation rate around the y-axis, in degrees per second. */
  gamma: number | null
  interval: number | null
}

export interface DeviceRotationSnapshot {
  orientation: DeviceOrientationReading | null
  rotationRate: DeviceRotationRateReading | null
  permission: DeviceRotationPermissionState
  timestamp: number
  hasReading: boolean
}

export type DeviceRotationListener = (snapshot: DeviceRotationSnapshot) => void

export interface DeviceRotationSubscribeOptions {
  /** Listen to `deviceorientationabsolute` too. Requires magnetometer permission where gated. */
  absolute?: boolean
  /** Immediately emit the current cached snapshot to this subscriber. */
  emitCurrent?: boolean
}

export interface DeviceRotationPermissionOptions {
  /** Request magnetometer-backed absolute orientation when the browser supports it. */
  absolute?: boolean
  /** Request `devicemotion` too. Orientation-only effects can leave this off to avoid extra prompts. */
  includeMotion?: boolean
}

const listeners = new Set<DeviceRotationListener>()

let orientation: DeviceOrientationReading | null = null
let rotationRate: DeviceRotationRateReading | null = null
let permission: DeviceRotationPermissionState = 'unknown'
let timestamp = 0
let listening = false
let absoluteListenerCount = 0

function hasWindow(): boolean {
  return typeof window !== 'undefined'
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

function normalize(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function getOrientationConstructor(): PermissionCapableConstructor | null {
  if (!hasWindow() || !('DeviceOrientationEvent' in window)) return null
  return window.DeviceOrientationEvent as unknown as PermissionCapableConstructor
}

function getMotionConstructor(): PermissionCapableConstructor | null {
  if (!hasWindow() || !('DeviceMotionEvent' in window)) return null
  return window.DeviceMotionEvent as unknown as PermissionCapableConstructor
}

function supportsOrientation(): boolean {
  return hasWindow() && ('DeviceOrientationEvent' in window || 'ondeviceorientation' in window)
}

function supportsMotion(): boolean {
  return hasWindow() && ('DeviceMotionEvent' in window || 'ondevicemotion' in window)
}

function needsPermission(): boolean {
  return typeof getOrientationConstructor()?.requestPermission === 'function' ||
    typeof getMotionConstructor()?.requestPermission === 'function'
}

function snapshot(): DeviceRotationSnapshot {
  return {
    orientation,
    rotationRate,
    permission,
    timestamp,
    hasReading: Boolean(orientation || rotationRate),
  }
}

function notify(): void {
  const current = snapshot()
  for (const listener of listeners) {
    try { listener(current) } catch { /* isolate subscribers */ }
  }
}

function handleOrientation(event: DeviceOrientationEvent): void {
  orientation = {
    alpha: normalize(event.alpha),
    beta: normalize(event.beta),
    gamma: normalize(event.gamma),
    absolute: Boolean(event.absolute),
  }
  timestamp = now()
  if (permission === 'unknown' || permission === 'prompt') permission = 'granted'
  notify()
}

function handleMotion(event: DeviceMotionEvent): void {
  const rate = event.rotationRate
  rotationRate = rate
    ? {
        alpha: normalize(rate.alpha),
        beta: normalize(rate.beta),
        gamma: normalize(rate.gamma),
        interval: normalize(event.interval),
      }
    : null
  timestamp = now()
  if (permission === 'unknown' || permission === 'prompt') permission = 'granted'
  notify()
}

function handleAbsoluteOrientation(event: Event): void {
  handleOrientation(event as DeviceOrientationEvent)
}

function startListening(): void {
  if (!hasWindow() || listening) return
  window.addEventListener('deviceorientation', handleOrientation)
  window.addEventListener('devicemotion', handleMotion)
  listening = true
}

function stopListening(): void {
  if (!hasWindow() || !listening || listeners.size > 0) return
  window.removeEventListener('deviceorientation', handleOrientation)
  window.removeEventListener('devicemotion', handleMotion)
  window.removeEventListener('deviceorientationabsolute', handleAbsoluteOrientation)
  listening = false
  absoluteListenerCount = 0
}

function updateAbsoluteListener(): void {
  if (!hasWindow() || !listening) return
  if (absoluteListenerCount > 0) {
    window.addEventListener('deviceorientationabsolute', handleAbsoluteOrientation)
  } else {
    window.removeEventListener('deviceorientationabsolute', handleAbsoluteOrientation)
  }
}

export function isDeviceRotationSupported(): boolean {
  return supportsOrientation() || supportsMotion()
}

export function doesDeviceRotationNeedPermission(): boolean {
  return needsPermission()
}

/**
 * Call from a trusted user gesture before subscribing on iOS/Safari.
 * Android/Chrome usually has no request method today, so supported secure pages resolve as granted.
 */
export async function requestDeviceRotationPermission(
  options: DeviceRotationPermissionOptions = {},
): Promise<DeviceRotationPermissionResult> {
  if (!hasWindow()) {
    permission = 'unsupported'
    return { state: permission, requiresUserGesture: false, reason: 'window_unavailable' }
  }

  if (!isDeviceRotationSupported()) {
    permission = 'unsupported'
    return { state: permission, requiresUserGesture: false, reason: 'events_unavailable' }
  }

  if (!window.isSecureContext) {
    permission = 'unavailable'
    return { state: permission, requiresUserGesture: false, reason: 'secure_context_required' }
  }

  const requesters: Promise<PermissionRequestState>[] = []
  const orientationConstructor = getOrientationConstructor()
  const motionConstructor = getMotionConstructor()

  try {
    // Invoke all permission prompts before awaiting so Safari keeps the transient activation.
    if (typeof orientationConstructor?.requestPermission === 'function') {
      requesters.push(orientationConstructor.requestPermission(options.absolute === true))
    }
    if (options.includeMotion !== false && typeof motionConstructor?.requestPermission === 'function') {
      requesters.push(motionConstructor.requestPermission())
    }
  } catch (err) {
    permission = 'prompt'
    return {
      state: permission,
      requiresUserGesture: true,
      reason: err instanceof Error && err.name === 'NotAllowedError' ? 'user_gesture_required' : 'request_failed',
    }
  }

  if (requesters.length === 0) {
    permission = 'granted'
    return { state: permission, requiresUserGesture: false }
  }

  const results = await Promise.allSettled(requesters)
  if (results.some((result) => result.status === 'fulfilled' && result.value === 'denied')) {
    permission = 'denied'
    return { state: permission, requiresUserGesture: true, reason: 'permission_denied' }
  }

  const rejected = results.find((result) => result.status === 'rejected')
  if (rejected) {
    permission = 'prompt'
    const reason = rejected.reason instanceof Error && rejected.reason.name === 'NotAllowedError'
      ? 'user_gesture_required'
      : 'request_failed'
    return { state: permission, requiresUserGesture: true, reason }
  }

  permission = 'granted'
  return { state: permission, requiresUserGesture: true }
}

export function getDeviceRotationSnapshot(): DeviceRotationSnapshot {
  return snapshot()
}

export function subscribeDeviceRotation(
  listener: DeviceRotationListener,
  options: DeviceRotationSubscribeOptions = {},
): () => void {
  listeners.add(listener)
  startListening()

  if (options.absolute) {
    absoluteListenerCount += 1
    updateAbsoluteListener()
  }

  if (options.emitCurrent) listener(snapshot())

  return () => {
    listeners.delete(listener)
    if (options.absolute) {
      absoluteListenerCount = Math.max(0, absoluteListenerCount - 1)
      updateAbsoluteListener()
    }
    stopListening()
  }
}
