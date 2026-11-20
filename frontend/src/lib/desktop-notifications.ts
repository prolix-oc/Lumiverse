import { hasTauriDesktopBridge } from '@/lib/desktopWebView'
import { invoke } from '@tauri-apps/api/core'

export interface DesktopNotificationDeviceState {
  deviceId: string
  enrollment: {
    destinationId: string
    serverInstanceId: string
    serverOrigin: string
  } | null
}

export interface DesktopNotificationEnrollmentInput {
  deviceId: string
  destinationId: string
  credential: string
  serverInstanceId: string
  serverOrigin: string
}

export type DesktopNotificationTransportState =
  | 'not_enrolled'
  | 'connecting'
  | 'connected'
  | 'retrying'
  | 'blocked'
  | 'stopped'

export interface DesktopNotificationTransportStatus {
  transportVersion: number
  state: DesktopNotificationTransportState
  destinationId: string | null
  serverOrigin: string | null
  lastError: string | null
  connectedAt: number | null
  lastReceivedAt: number | null
  lastNotificationAt: number | null
}

export function isTauriDesktop(): boolean {
  return hasTauriDesktopBridge()
}

export function getDesktopNotificationDevice(): Promise<DesktopNotificationDeviceState> {
  return invoke('desktop_notification_device')
}

export function getDesktopNotificationPermission(request = false): Promise<NotificationPermission> {
  return invoke<NotificationPermission>('desktop_notification_permission', { request })
}

export function getDesktopNotificationTransportStatus(): Promise<DesktopNotificationTransportStatus> {
  return invoke<DesktopNotificationTransportStatus>('desktop_notification_transport_status')
}

export function saveDesktopNotificationEnrollment(
  enrollment: DesktopNotificationEnrollmentInput,
): Promise<void> {
  return invoke('save_desktop_notification_enrollment', { enrollment })
}

export function clearDesktopNotificationEnrollment(destinationId?: string): Promise<boolean> {
  return invoke('clear_desktop_notification_enrollment', { destinationId })
}
