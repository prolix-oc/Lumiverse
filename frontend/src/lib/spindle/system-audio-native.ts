import i18n from '@/i18n'
import { useStore } from '@/store'
import { generateUUID } from '@/lib/uuid'
import { createFrontendSystemAudioAPI, type FrontendSystemAudioDependencies } from './system-audio-api'
import { getSystemAudioSource } from './system-audio-source'
import { systemAudioConsent } from './system-audio-consent'

/**
 * The consent prompt reuses the host's own confirmation dialog, which names the extension in its title. Every word
 * of the body comes from the host's locale files: an extension cannot influence what the user is asked.
 */
function confirmWithHost(userId: string | null, extensionId: string, extensionName: string, signal: AbortSignal, authorize: () => void): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  const consent = systemAudioConsent.read(userId, extensionId)
  if (consent.paused) return Promise.resolve(false)
  if (consent.remembered) return Promise.resolve(true)
  const requestId = generateUUID()
  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (confirmed: boolean) => {
      if (settled) return
      settled = true
      window.removeEventListener('spindle:confirm-resolved', onResolved)
      signal.removeEventListener('abort', onAbort)
      resolve(confirmed)
    }
    const onResolved = ((event: CustomEvent) => {
      if (event.detail?.requestId !== requestId) return
      const approved = Boolean(event.detail.confirmed) && !signal.aborted
        && (useStore.getState().user?.id ?? null) === userId
        && !systemAudioConsent.read(userId, extensionId).paused
      if (approved) {
        try { authorize() } catch { done(false); return }
      }
      if (approved && event.detail.checkboxChecked === true) systemAudioConsent.remember(userId, extensionId)
      done(approved)
    }) as EventListener
    const onAbort = () => {
      const pending = useStore.getState().pendingConfirm
      if (pending?.requestId === requestId) useStore.setState({ pendingConfirm: null })
      done(false)
    }
    window.addEventListener('spindle:confirm-resolved', onResolved)
    signal.addEventListener('abort', onAbort, { once: true })
    useStore.getState().openSpindleConfirm({
      requestId,
      extensionId,
      extensionName,
      title: i18n.t('shared:spindle.systemAudio.consentTitle'),
      message: i18n.t('shared:spindle.systemAudio.consentMessage'),
      variant: 'warning',
      confirmLabel: i18n.t('shared:spindle.systemAudio.allow'),
      cancelLabel: i18n.t('shared:spindle.systemAudio.notNow'),
      checkboxLabel: i18n.t('shared:spindle.systemAudio.remember'),
    })
  })
}

export function createNativeSystemAudioAPI(
  deps: Pick<FrontendSystemAudioDependencies, 'assertActive' | 'requirePermission' | 'onTeardown'> & {
    extensionId: string
    extensionName: string
  },
) {
  const { extensionId, extensionName, ...rest } = deps
  const userId = useStore.getState().user?.id ?? null
  let unwatchConsent = () => {}
  let unwatchOwner = () => {}
  const unwatch = () => { unwatchConsent(); unwatchOwner() }
  const controller = createFrontendSystemAudioAPI({
    ...rest,
    assertActive() {
      rest.assertActive()
      if ((useStore.getState().user?.id ?? null) !== userId) {
        throw new Error('SPINDLE_FRONTEND_INACTIVE: system audio belongs to another account')
      }
    },
    onTeardown(handler) {
      return rest.onTeardown(() => { unwatch(); handler() })
    },
    getSource: getSystemAudioSource,
    requestConsent: (signal) => confirmWithHost(userId, extensionId, extensionName, signal, () => {
      rest.assertActive()
      rest.requirePermission('system_audio', 'ctx.systemAudio.start')
    }),
    showIndicator(stop) {
      const id = generateUUID()
      useStore.getState().addSystemAudioSession({
        id, extensionId, extensionName,
        stop() {
          systemAudioConsent.pause(userId, extensionId)
          stop()
        },
      })
      return () => useStore.getState().removeSystemAudioSession(id)
    },
  })
  unwatchConsent = systemAudioConsent.subscribe(userId, extensionId, (consent, change, previous) => {
    if (change === 'revoke' || change === 'clear' || (change === 'external' && previous.remembered && !consent.remembered)) controller.revoke()
    else if (consent.paused) controller.pause()
  })
  unwatchOwner = useStore.subscribe((state) => {
    if ((state.user?.id ?? null) !== userId) { unwatch(); controller.dispose() }
  })
  return {
    ...controller,
    revoke() {
      systemAudioConsent.clear(userId, extensionId)
      controller.revoke()
    },
    dispose() { unwatch(); controller.dispose() },
  }
}
