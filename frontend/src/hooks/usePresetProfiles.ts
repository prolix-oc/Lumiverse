import { useState, useEffect, useCallback, useMemo } from 'react'
import { useStore } from '@/store'
import { presetProfilesApi, type PresetProfileBinding } from '@/api/preset-profiles'
import type { PromptBlock } from '@/lib/loom/types'

/**
 * Captures the current block enabled/disabled states as a map of block ID → boolean.
 */
function snapshotBlockStates(blocks: PromptBlock[]): Record<string, boolean> {
  const states: Record<string, boolean> = {}
  for (const block of blocks) {
    states[block.id] = block.enabled
  }
  return states
}

export function usePresetProfiles(presetId: string | null, blocks: PromptBlock[] | undefined) {
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const addToast = useStore((s) => s.addToast)

  const [defaults, setDefaults] = useState<PresetProfileBinding | null>(null)
  const [chatBinding, setChatBinding] = useState<PresetProfileBinding | null>(null)
  const [characterBinding, setCharacterBinding] = useState<PresetProfileBinding | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const hasDefaults = defaults !== null && defaults.preset_id === presetId

  // Load defaults on mount / preset change
  useEffect(() => {
    if (!presetId) { setDefaults(null); return }
    presetProfilesApi.getDefaults()
      .then((d) => setDefaults(d))
      .catch(() => setDefaults(null))
  }, [presetId])

  // Load chat binding when chat changes
  useEffect(() => {
    if (!activeChatId || !presetId) { setChatBinding(null); return }
    setChatBinding(null) // Clear stale binding before fetching new one
    presetProfilesApi.getChatBinding(activeChatId)
      .then((b) => setChatBinding(b))
      .catch(() => setChatBinding(null))
  }, [activeChatId, presetId])

  // Load character binding when character changes
  useEffect(() => {
    if (!activeCharacterId || !presetId) { setCharacterBinding(null); return }
    setCharacterBinding(null) // Clear stale binding before fetching new one
    presetProfilesApi.getCharacterBinding(activeCharacterId)
      .then((b) => setCharacterBinding(b))
      .catch(() => setCharacterBinding(null))
  }, [activeCharacterId, presetId])

  // Capture defaults
  const captureDefaults = useCallback(async () => {
    if (!presetId || !blocks) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.captureDefaults(presetId, snapshotBlockStates(blocks))
      setDefaults(binding)
      addToast({ type: 'success', message: 'Default block states captured' })
    } catch {
      addToast({ type: 'error', message: 'Failed to capture defaults' })
    } finally {
      setIsLoading(false)
    }
  }, [presetId, blocks, addToast])

  // Clear defaults
  const clearDefaults = useCallback(async () => {
    setIsLoading(true)
    try {
      await presetProfilesApi.deleteDefaults()
      setDefaults(null)
      addToast({ type: 'info', message: 'Default block states cleared' })
    } catch {
      addToast({ type: 'error', message: 'Failed to clear defaults' })
    } finally {
      setIsLoading(false)
    }
  }, [addToast])

  // Bind to current chat
  const bindToChat = useCallback(async () => {
    if (!presetId || !blocks || !activeChatId) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.setChatBinding(activeChatId, presetId, snapshotBlockStates(blocks))
      setChatBinding(binding)
      addToast({ type: 'success', message: 'Block states bound to this chat' })
    } catch {
      addToast({ type: 'error', message: 'Failed to bind to chat' })
    } finally {
      setIsLoading(false)
    }
  }, [presetId, blocks, activeChatId, addToast])

  // Unbind from current chat
  const unbindChat = useCallback(async () => {
    if (!activeChatId) return
    setIsLoading(true)
    try {
      await presetProfilesApi.deleteChatBinding(activeChatId)
      setChatBinding(null)
      addToast({ type: 'info', message: 'Chat binding removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove chat binding' })
    } finally {
      setIsLoading(false)
    }
  }, [activeChatId, addToast])

  // Bind to current character
  const bindToCharacter = useCallback(async () => {
    if (!presetId || !blocks || !activeCharacterId) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.setCharacterBinding(activeCharacterId, presetId, snapshotBlockStates(blocks))
      setCharacterBinding(binding)
      addToast({ type: 'success', message: 'Block states bound to this character' })
    } catch {
      addToast({ type: 'error', message: 'Failed to bind to character' })
    } finally {
      setIsLoading(false)
    }
  }, [presetId, blocks, activeCharacterId, addToast])

  // Unbind from current character
  const unbindCharacter = useCallback(async () => {
    if (!activeCharacterId) return
    setIsLoading(true)
    try {
      await presetProfilesApi.deleteCharacterBinding(activeCharacterId)
      setCharacterBinding(null)
      addToast({ type: 'info', message: 'Character binding removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove character binding' })
    } finally {
      setIsLoading(false)
    }
  }, [activeCharacterId, addToast])

  // Resolved active binding (chat > character > defaults > none)
  const activeBinding = useMemo(() => {
    if (chatBinding && chatBinding.preset_id === presetId) return chatBinding
    if (characterBinding && characterBinding.preset_id === presetId) return characterBinding
    if (defaults && defaults.preset_id === presetId) return defaults
    return null
  }, [chatBinding, characterBinding, defaults, presetId])

  // Determine active source
  const activeSource: 'chat' | 'character' | 'defaults' | 'none' = (() => {
    if (chatBinding && chatBinding.preset_id === presetId) return 'chat'
    if (characterBinding && characterBinding.preset_id === presetId) return 'character'
    if (defaults && defaults.preset_id === presetId) return 'defaults'
    return 'none'
  })()

  const hasChatBinding = chatBinding !== null && chatBinding.preset_id === presetId
  const hasCharacterBinding = characterBinding !== null && characterBinding.preset_id === presetId

  return {
    // State
    hasDefaults,
    hasChatBinding,
    hasCharacterBinding,
    activeSource,
    activeBinding,
    isLoading,
    defaults,
    chatBinding,
    characterBinding,

    // Actions
    captureDefaults,
    clearDefaults,
    bindToChat,
    unbindChat,
    bindToCharacter,
    unbindCharacter,
  }
}
