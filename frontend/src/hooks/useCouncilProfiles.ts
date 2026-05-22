import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'
import { councilApi, type CouncilProfileBinding, type CouncilSidecarConfig, type ResolvedCouncilProfile } from '@/api/council'
import { settingsApi } from '@/api/settings'
import type { CouncilPersistenceTarget } from '@/types/store'

const SIDECAR_DEFAULTS: CouncilSidecarConfig = {
  connectionProfileId: '',
  model: '',
  temperature: 0.7,
  topP: 0.9,
  maxTokens: 1024,
}

type ChatSlot = { for: string | null; binding: CouncilProfileBinding | null }
type CharSlot = { for: string | null; binding: CouncilProfileBinding | null }

const EMPTY_CHAT_SLOT: ChatSlot = { for: null, binding: null }
const EMPTY_CHAR_SLOT: CharSlot = { for: null, binding: null }

const SIDECAR_SAVE_DEBOUNCE_MS = 500

function isSidecarObject(value: unknown): value is Partial<CouncilSidecarConfig> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function councilSourceToTarget(
  source: ResolvedCouncilProfile['source'],
  ctx: { chatId: string | null; characterId: string | null },
): CouncilPersistenceTarget {
  switch (source) {
    case 'chat':
      return { type: 'chat', chatId: ctx.chatId }
    case 'character':
      return { type: 'character', characterId: ctx.characterId }
    case 'defaults':
      return { type: 'defaults' }
    case 'none':
    default:
      return { type: 'global' }
  }
}

async function loadGlobalSidecar(): Promise<CouncilSidecarConfig> {
  try {
    const row = await settingsApi.get('sidecarSettings')
    if (isSidecarObject(row?.value)) {
      return { ...SIDECAR_DEFAULTS, ...row.value }
    }
  } catch {
    // fall through to legacy/default handling
  }

  try {
    const row = await settingsApi.get('council_settings')
    const legacy = row?.value?.toolsSettings?.sidecar
    if (legacy?.connectionProfileId) {
      return {
        connectionProfileId: legacy.connectionProfileId,
        model: legacy.model || '',
        temperature: legacy.temperature ?? SIDECAR_DEFAULTS.temperature,
        topP: legacy.topP ?? SIDECAR_DEFAULTS.topP,
        maxTokens: legacy.maxTokens ?? SIDECAR_DEFAULTS.maxTokens,
      }
    }
  } catch {
    // ignore
  }

  return { ...SIDECAR_DEFAULTS }
}

export function useCouncilProfiles() {
  const councilSettings = useStore((s) => s.councilSettings)
  const councilPersistenceTarget = useStore((s) => s.councilPersistenceTarget)
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const setCouncilSettings = useStore((s) => s.setCouncilSettings)
  const setCouncilPersistenceTarget = useStore((s) => s.setCouncilPersistenceTarget)
  const addToast = useStore((s) => s.addToast)

  const [defaults, setDefaults] = useState<CouncilProfileBinding | null>(null)
  const [chatSlot, setChatSlot] = useState<ChatSlot>(EMPTY_CHAT_SLOT)
  const [charSlot, setCharSlot] = useState<CharSlot>(EMPTY_CHAR_SLOT)
  const [sidecarConfig, setSidecarConfig] = useState<CouncilSidecarConfig>(SIDECAR_DEFAULTS)
  const [activeSource, setActiveSource] = useState<ResolvedCouncilProfile['source']>('none')
  const [isLoading, setIsLoading] = useState(false)

  const sidecarSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSidecarRef = useRef<CouncilSidecarConfig | null>(null)

  const characterBindingEnabled = !isGroupChat

  const applyResolved = useCallback((resolved: ResolvedCouncilProfile) => {
    setCouncilSettings(resolved.council_settings)
    setCouncilPersistenceTarget(
      councilSourceToTarget(resolved.source, {
        chatId: activeChatId,
        characterId: characterBindingEnabled ? activeCharacterId : null,
      }),
    )
    setSidecarConfig({ ...SIDECAR_DEFAULTS, ...resolved.sidecar_settings })
    setActiveSource(resolved.source)
  }, [activeChatId, activeCharacterId, characterBindingEnabled, setCouncilPersistenceTarget, setCouncilSettings])

  const refreshDefaults = useCallback(async () => {
    try {
      const binding = await councilApi.getDefaults()
      setDefaults(binding)
    } catch {
      setDefaults(null)
    }
  }, [])

  const refreshResolved = useCallback(async () => {
    if (!activeChatId) {
      const settings = await councilApi.getSettings()
      setCouncilSettings(settings)
      setCouncilPersistenceTarget({ type: 'global' })
      setSidecarConfig(await loadGlobalSidecar())
      setActiveSource('none')
      return
    }
    const resolved = await councilApi.resolve(activeChatId)
    applyResolved(resolved)
  }, [activeChatId, applyResolved, setCouncilPersistenceTarget, setCouncilSettings])

  useEffect(() => {
    void refreshDefaults()
  }, [refreshDefaults])

  useEffect(() => {
    if (!activeChatId) {
      setChatSlot(EMPTY_CHAT_SLOT)
      return
    }
    const target = activeChatId
    let cancelled = false
    setChatSlot((prev) => (prev.for === target ? prev : EMPTY_CHAT_SLOT))
    councilApi.getChatBinding(target)
      .then((binding) => { if (!cancelled) setChatSlot({ for: target, binding }) })
      .catch(() => { if (!cancelled) setChatSlot({ for: target, binding: null }) })
    return () => { cancelled = true }
  }, [activeChatId])

  useEffect(() => {
    if (!activeCharacterId || !characterBindingEnabled) {
      setCharSlot(EMPTY_CHAR_SLOT)
      return
    }
    const target = activeCharacterId
    let cancelled = false
    setCharSlot((prev) => (prev.for === target ? prev : EMPTY_CHAR_SLOT))
    councilApi.getCharacterBinding(target)
      .then((binding) => { if (!cancelled) setCharSlot({ for: target, binding }) })
      .catch(() => { if (!cancelled) setCharSlot({ for: target, binding: null }) })
    return () => { cancelled = true }
  }, [activeCharacterId, characterBindingEnabled])

  useEffect(() => {
    let cancelled = false
    refreshResolved().catch(() => {
      if (!cancelled) {
        setCouncilPersistenceTarget({ type: 'global' })
        setActiveSource('none')
      }
    })
    return () => { cancelled = true }
  }, [refreshResolved, setCouncilPersistenceTarget])

  const persistSidecar = useCallback(async (next: CouncilSidecarConfig) => {
    switch (councilPersistenceTarget.type) {
      case 'defaults':
        await councilApi.putDefaults({ sidecar_settings: next })
        return
      case 'character':
        if (!councilPersistenceTarget.characterId) return
        await councilApi.putCharacterBinding(councilPersistenceTarget.characterId, { sidecar_settings: next })
        return
      case 'chat':
        if (!councilPersistenceTarget.chatId) return
        await councilApi.putChatBinding(councilPersistenceTarget.chatId, { sidecar_settings: next })
        return
      case 'global':
      default:
        await settingsApi.put('sidecarSettings', next)
    }
  }, [councilPersistenceTarget])

  const saveSidecar = useCallback((partial: Partial<CouncilSidecarConfig>) => {
    setSidecarConfig((prev) => {
      const next = { ...prev, ...partial }
      pendingSidecarRef.current = next

      if (sidecarSaveTimerRef.current) {
        clearTimeout(sidecarSaveTimerRef.current)
      }

      sidecarSaveTimerRef.current = setTimeout(() => {
        sidecarSaveTimerRef.current = null
        const toSave = pendingSidecarRef.current
        pendingSidecarRef.current = null
        if (toSave) {
          void persistSidecar(toSave).catch(() => {
            addToast({ type: 'error', message: 'Failed to save sidecar settings' })
          })
        }
      }, SIDECAR_SAVE_DEBOUNCE_MS)

      return next
    })
  }, [addToast, persistSidecar])

  // Flush any pending sidecar save when the hook unmounts or persistence target changes
  useEffect(() => {
    return () => {
      if (sidecarSaveTimerRef.current) {
        clearTimeout(sidecarSaveTimerRef.current)
        sidecarSaveTimerRef.current = null
      }
      const toSave = pendingSidecarRef.current
      pendingSidecarRef.current = null
      if (toSave) {
        void persistSidecar(toSave).catch(() => {})
      }
    }
  }, [persistSidecar])

  const captureDefaults = useCallback(async () => {
    setIsLoading(true)
    try {
      const binding = await councilApi.putDefaults({
        council_settings: councilSettings,
        sidecar_settings: sidecarConfig,
      })
      setDefaults(binding)
      if (activeChatId) await refreshResolved()
      addToast({ type: 'success', message: 'Default council profile saved' })
    } catch {
      addToast({ type: 'error', message: 'Failed to save default council profile' })
    } finally {
      setIsLoading(false)
    }
  }, [activeChatId, addToast, councilSettings, refreshResolved, sidecarConfig])

  const clearDefaults = useCallback(async () => {
    setIsLoading(true)
    try {
      await councilApi.deleteDefaults()
      setDefaults(null)
      await refreshResolved()
      addToast({ type: 'info', message: 'Default council profile cleared' })
    } catch {
      addToast({ type: 'error', message: 'Failed to clear default council profile' })
    } finally {
      setIsLoading(false)
    }
  }, [addToast, refreshResolved])

  const bindToChat = useCallback(async () => {
    if (!activeChatId) return
    setIsLoading(true)
    try {
      const binding = await councilApi.putChatBinding(activeChatId, {
        council_settings: councilSettings,
        sidecar_settings: sidecarConfig,
      })
      setChatSlot({ for: activeChatId, binding })
      await refreshResolved()
      addToast({ type: 'success', message: 'Council profile bound to this chat' })
    } catch {
      addToast({ type: 'error', message: 'Failed to bind council profile to chat' })
    } finally {
      setIsLoading(false)
    }
  }, [activeChatId, addToast, councilSettings, refreshResolved, sidecarConfig])

  const unbindChat = useCallback(async () => {
    if (!activeChatId) return
    setIsLoading(true)
    try {
      await councilApi.deleteChatBinding(activeChatId)
      setChatSlot({ for: activeChatId, binding: null })
      await refreshResolved()
      addToast({ type: 'info', message: 'Chat council binding removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove chat council binding' })
    } finally {
      setIsLoading(false)
    }
  }, [activeChatId, addToast, refreshResolved])

  const bindToCharacter = useCallback(async () => {
    if (!activeCharacterId || !characterBindingEnabled) return
    setIsLoading(true)
    try {
      const binding = await councilApi.putCharacterBinding(activeCharacterId, {
        council_settings: councilSettings,
        sidecar_settings: sidecarConfig,
      })
      setCharSlot({ for: activeCharacterId, binding })
      await refreshResolved()
      addToast({ type: 'success', message: 'Council profile bound to this character' })
    } catch {
      addToast({ type: 'error', message: 'Failed to bind council profile to character' })
    } finally {
      setIsLoading(false)
    }
  }, [activeCharacterId, addToast, characterBindingEnabled, councilSettings, refreshResolved, sidecarConfig])

  const unbindCharacter = useCallback(async () => {
    if (!activeCharacterId || !characterBindingEnabled) return
    setIsLoading(true)
    try {
      await councilApi.deleteCharacterBinding(activeCharacterId)
      setCharSlot({ for: activeCharacterId, binding: null })
      await refreshResolved()
      addToast({ type: 'info', message: 'Character council binding removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove character council binding' })
    } finally {
      setIsLoading(false)
    }
  }, [activeCharacterId, addToast, characterBindingEnabled, refreshResolved])

  const chatBinding = chatSlot.for === activeChatId ? chatSlot.binding : null
  const characterBinding = charSlot.for === activeCharacterId ? charSlot.binding : null

  return {
    activeChatId,
    activeCharacterId,
    activeSource,
    characterBindingEnabled,
    defaults,
    hasDefaults: defaults !== null,
    hasChatBinding: chatBinding !== null,
    hasCharacterBinding: characterBindingEnabled && characterBinding !== null,
    isLoading,
    sidecarConfig,
    saveSidecar,
    captureDefaults,
    clearDefaults,
    bindToChat,
    unbindChat,
    bindToCharacter,
    unbindCharacter,
    refreshResolved,
  }
}
