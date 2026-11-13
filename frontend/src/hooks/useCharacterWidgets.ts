import { useEffect } from 'react'
import { post } from '@/api/client'
import { useStore } from '@/store'
import { characterWidgetNative } from '@/lib/character-widget-native'
import { hasUnsavedSettings } from '@/store/slices/settings'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'
import { toOpaqueRgbChannels } from '@/theme/themeColor'

interface WidgetStatus { available: boolean; deviceId: string; needsEnrollment: boolean }
function palette() {
  const style = getComputedStyle(document.documentElement)
  const color = (key: string, fallback: string) => {
    const channels = toOpaqueRgbChannels(style.getPropertyValue(key).trim())
    return channels ? '#' + channels.map(channel => channel.toString(16).padStart(2, '0')).join('') : fallback
  }
  return { background: color('--lumiverse-bg-deep', '#171321'), foreground: color('--lumiverse-text', '#f5f0ff'), accent: color('--lumiverse-primary', '#bca6ff') }
}

/** Mounted outside AuthGuard so logout and session loss clear native data too. */
export function useCharacterWidgets(userId: string | null | undefined) {
  useEffect(() => {
    const native = characterWidgetNative()
    if (!native || userId === undefined) return
    const configure = (enrollment?: Record<string, unknown>) => native.request<WidgetStatus>('widgets.configure', {
      accountId: userId, serverOrigin: window.location.origin, palette: palette(), ...(enrollment ? { enrollment } : {}),
    })
    if (!userId) { void configure().catch(() => {}); return }
    const recovery = native.sync(async signal => {
      // Older native wrappers don't expose widgets. Don't turn that into retries.
      const support = await native.request<WidgetStatus>('widgets.status').catch(() => null)
      if (signal.aborted || !support?.available) return
      const status = await configure()
      if (signal.aborted) return
      if (status.needsEnrollment) {
        const enrollment = await post<Record<string, unknown>>('/ios-widgets/registrations', { deviceId: status.deviceId }, { signal })
        if (signal.aborted) return
        await configure(enrollment)
      }
      if (signal.aborted || hasUnsavedSettings()) return
      await native.request('widgets.refresh')
    }, 60_000)
    const invalidate = () => {
      void native.request('widgets.invalidate').catch(() => {})
      recovery.request()
    }
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.favorites !== previous.favorites || state.landingHiddenCharacterIds !== previous.landingHiddenCharacterIds
        || state.characters !== previous.characters) invalidate()
      else if (state.theme !== previous.theme) recovery.request()
    })
    const off = [EventType.SETTINGS_UPDATED, EventType.CHARACTER_EDITED, EventType.CHARACTER_DELETED,
      EventType.CHARACTER_LIBRARY_CHANGED, EventType.IMAGE_DELETED, EventType.CHAT_CHANGED, EventType.CHAT_DELETED,
      EventType.CHAT_CREATED, EventType.GENERATION_ENDED, EventType.MESSAGE_SENT].map(event => wsClient.on(event, invalidate))
    return () => { recovery.stop(); unsubscribe(); off.forEach(stop => stop()) }
  }, [userId])
}
