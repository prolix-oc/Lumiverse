import { useSyncExternalStore } from 'react'
import { iosNativeRequest } from './ios-native'

const key = 'lumiverse:iosLiveActivitiesEnabled'
const changed = 'lumiverse:ios-live-activities-preference'
let volatilePreference: boolean | undefined
function readPreference() {
  if (volatilePreference !== undefined) return volatilePreference
  try { return localStorage.getItem(key) !== 'false' } catch { return true }
}
function subscribe(listener: () => void) {
  window.addEventListener(changed, listener)
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener(changed, listener); window.removeEventListener('storage', listener) }
}
export function useIOSLiveActivitiesEnabled() { return useSyncExternalStore(subscribe, readPreference, () => true) }
export function setIOSLiveActivitiesEnabled(value: boolean) {
  volatilePreference = value
  try { localStorage.setItem(key, String(value)); volatilePreference = undefined } catch { /* Keep the choice for this session. */ }
  window.dispatchEvent(new Event(changed))
}
export interface IOSActivityStatus {
  available: boolean
  relayEnrolled?: boolean
  spindleAvailable?: boolean
  spindleRegistrationIds?: string[]
  generationIds: string[]
  suppressedGenerationIds: string[]
  deviceId: string
  bundleId: string
  environment: 'development' | 'production'
}
export interface ActivitySnapshot { generationId: string; state: { phase: string; label: string } }
export const getIOSActivityStatus = () => iosNativeRequest<IOSActivityStatus>('activities.status')
