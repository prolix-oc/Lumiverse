import { hasIOSNativeBridge, iosNativeRequest } from './ios-native'

type PermissionRequestState = 'granted' | 'denied'

export interface DeviceAttitudeQuaternion { x: number; y: number; z: number; w: number }

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
  quaternion?: DeviceAttitudeQuaternion | null
  /** Changes when a sensor stream restarts; consumers should recalibrate. */
  reference?: number
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
let quaternion: DeviceAttitudeQuaternion | null = null
let reference = 0
let nativeID: string | null = null
let nativeTransport: NativeMotionTransport | null = null
let nativeUnavailable = false
let streamID = 0

interface NativeMotionTransport {
  event: string
  request<T>(action: string, payload: Record<string, unknown>): Promise<T>
}

function getNativeMotionTransport(): NativeMotionTransport | null {
  if (!hasWindow() || nativeUnavailable) return null
  if (hasIOSNativeBridge() &&
    (window as Window & { __LUMIVERSE_IOS_NATIVE__?: { deviceMotion?: number } }).__LUMIVERSE_IOS_NATIVE__?.deviceMotion === 1) {
    return { event: 'lumiverse:ios-device-motion', request: iosNativeRequest }
  }
  const android = (window as Window & { __LUMIVERSE_ANDROID_MOTION__?: {
    version: number
    request<T>(action: string, payload: Record<string, unknown>): Promise<T>
  } }).__LUMIVERSE_ANDROID_MOTION__
  return android?.version === 1 && typeof android.request === 'function'
    ? { event: 'lumiverse:android-device-motion', request: (action, payload) => android.request(action, payload) }
    : null
}

function supportsNativeMotion(): boolean {
  return getNativeMotionTransport() !== null
}

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
  if (supportsNativeMotion()) return false
  return typeof getOrientationConstructor()?.requestPermission === 'function' ||
    typeof getMotionConstructor()?.requestPermission === 'function'
}

function snapshot(): DeviceRotationSnapshot {
  return {
    quaternion,
    reference,
    orientation,
    rotationRate,
    permission,
    timestamp,
    hasReading: Boolean(quaternion || orientation || rotationRate),
  }
}

function notify(): void {
  const current = snapshot()
  for (const listener of listeners) {
    try { listener(current) } catch { /* isolate subscribers */ }
  }
}

function handleOrientation(event: DeviceOrientationEvent): void {
  if (nativeID) return
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
  if (nativeID) return
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

function clearReading(): void {
  orientation = null
  rotationRate = null
  quaternion = null
  timestamp = 0
  reference++
}

function nativeFailed(id: string): void {
  if (nativeID !== id) return
  stopTransport()
  nativeUnavailable = true
  permission = needsPermission() ? 'prompt' : 'unknown'
  startTransport()
  notify()
}

function handleNativeMotion(event: Event): void {
  const detail = (event as CustomEvent).detail
  if (!nativeID || detail?.id !== nativeID) return
  if (detail.available === false) { nativeFailed(nativeID); return }
  const q = detail.quaternion
  if (!q || ![q.x, q.y, q.z, q.w].every(v => typeof v === 'number' && Number.isFinite(v))) return
  const length = Math.hypot(q.x, q.y, q.z, q.w)
  if (length < 0.5 || length > 1.5) return
  if (detail.reset) reference++
  quaternion = { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length }
  permission = 'granted'
  timestamp = now()
  notify()
}

function startTransport(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  clearReading()
  const transport = getNativeMotionTransport()
  if (transport) {
    const id = `rotation-${Date.now()}-${++streamID}`
    nativeID = id
    nativeTransport = transport
    window.addEventListener(transport.event, handleNativeMotion)
    void transport.request<{ available: boolean }>('motion.start', { id }).then(result => {
      if (!result?.available) nativeFailed(id)
    }).catch(() => nativeFailed(id))
    return
  }
  window.addEventListener('deviceorientation', handleOrientation)
  window.addEventListener('devicemotion', handleMotion)
  updateAbsoluteListener()
}

function stopTransport(): void {
  const id = nativeID
  const transport = nativeTransport
  nativeID = null
  nativeTransport = null
  if (transport) {
    if (id) void transport.request('motion.stop', { id }).catch(() => {})
    window.removeEventListener(transport.event, handleNativeMotion)
  }
  window.removeEventListener('deviceorientation', handleOrientation)
  window.removeEventListener('devicemotion', handleMotion)
  window.removeEventListener('deviceorientationabsolute', handleAbsoluteOrientation)
  clearReading()
}

function handleVisibility(): void {
  stopTransport()
  startTransport()
  notify()
}

function startListening(): void {
  if (!hasWindow() || listening) return
  listening = true
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility)
  startTransport()
}

function stopListening(): void {
  if (!hasWindow() || !listening || listeners.size > 0) return
  stopTransport()
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility)
  listening = false
  absoluteListenerCount = 0
  nativeUnavailable = false
}

function updateAbsoluteListener(): void {
  if (!hasWindow() || !listening || nativeID || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
  if (absoluteListenerCount > 0) {
    window.addEventListener('deviceorientationabsolute', handleAbsoluteOrientation)
  } else {
    window.removeEventListener('deviceorientationabsolute', handleAbsoluteOrientation)
  }
}

export function isDeviceRotationSupported(): boolean {
  return supportsNativeMotion() || supportsOrientation() || supportsMotion()
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

  if (supportsNativeMotion()) {
    return { state: 'granted', requiresUserGesture: false }
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
