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

// Bindings are cached with the chat/character id they were fetched for so
// stale fetches (e.g. left over from the previous chat) can't leak into the
// current context. The `for` field holds the id the binding was fetched
// against, or `null` when unresolved/inactive.
type ChatSlot = { for: string | null; binding: PresetProfileBinding | null }
type CharSlot = { for: string | null; binding: PresetProfileBinding | null }

const EMPTY_CHAT_SLOT: ChatSlot = { for: null, binding: null }
const EMPTY_CHAR_SLOT: CharSlot = { for: null, binding: null }

export function usePresetProfiles(
  presetId: string | null,
  blocks: PromptBlock[] | undefined,
) {
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const setActiveLoomPreset = useStore((s) => s.setActiveLoomPreset)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const addToast = useStore((s) => s.addToast)

  const [defaults, setDefaults] = useState<PresetProfileBinding | null>(null)
  const [chatSlot, setChatSlot] = useState<ChatSlot>(EMPTY_CHAT_SLOT)
  const [charSlot, setCharSlot] = useState<CharSlot>(EMPTY_CHAR_SLOT)
  const [isLoading, setIsLoading] = useState(false)

  // Load defaults for the currently selected preset. Defaults are stored per
  // preset, so switching presets should load a different default snapshot.
  useEffect(() => {
    if (!presetId) { setDefaults(null); return }
    let cancelled = false
    presetProfilesApi.getDefaults(presetId)
      .then((d) => { if (!cancelled) setDefaults(d) })
      .catch(() => { if (!cancelled) setDefaults(null) })
    return () => { cancelled = true }
  }, [presetId])

  // Load chat binding when chat changes. Stale fetches are discarded by the
  // cancelled flag, and the slot is keyed by the chat id it was fetched for so
  // downstream consumers can tell whether it's fresh for the current chat.
  useEffect(() => {
    if (!activeChatId) {
      setChatSlot(EMPTY_CHAT_SLOT)
      return
    }
    const target = activeChatId
    let cancelled = false
    // Drop any previous slot whose id doesn't match the new target so the
    // consumer doesn't observe a stale X-binding during the fetch window.
    setChatSlot((prev) => (prev.for === target ? prev : EMPTY_CHAT_SLOT))
    presetProfilesApi.getChatBinding(target)
      .then((b) => { if (!cancelled) setChatSlot({ for: target, binding: b }) })
      .catch(() => { if (!cancelled) setChatSlot({ for: target, binding: null }) })
    return () => { cancelled = true }
  }, [activeChatId])

  // Load character binding when character changes (same pattern as chat).
  useEffect(() => {
    if (!activeCharacterId) {
      setCharSlot(EMPTY_CHAR_SLOT)
      return
    }
    const target = activeCharacterId
    let cancelled = false
    setCharSlot((prev) => (prev.for === target ? prev : EMPTY_CHAR_SLOT))
    presetProfilesApi.getCharacterBinding(target)
      .then((b) => { if (!cancelled) setCharSlot({ for: target, binding: b }) })
      .catch(() => { if (!cancelled) setCharSlot({ for: target, binding: null }) })
    return () => { cancelled = true }
  }, [activeCharacterId])

  // A binding is only considered "for" the current context if its `for` id
  // still matches the store's active id. Anything else is stale.
  const chatBinding = chatSlot.for === activeChatId ? chatSlot.binding : null
  const characterBinding = charSlot.for === activeCharacterId ? charSlot.binding : null

  // isResolved: true when every applicable fetch has landed for the current
  // context. The LoomBuilder apply-effect waits on this so it doesn't overwrite
  // blocks with a stale binding mid-transition.
  const chatResolved = !activeChatId || chatSlot.for === activeChatId
  const characterResolved = !activeCharacterId || charSlot.for === activeCharacterId
  const isResolved = chatResolved && characterResolved

  const hasDefaults = defaults !== null

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
    if (!presetId) return
    setIsLoading(true)
    try {
      await presetProfilesApi.deleteDefaults(presetId)
      setDefaults(null)
      addToast({ type: 'info', message: 'Default block states cleared' })
    } catch {
      addToast({ type: 'error', message: 'Failed to clear defaults' })
    } finally {
      setIsLoading(false)
    }
  }, [presetId, addToast])

  // Bind to current chat
  const bindToChat = useCallback(async () => {
    if (!presetId || !blocks || !activeChatId) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.setChatBinding(activeChatId, presetId, snapshotBlockStates(blocks))
      setChatSlot({ for: activeChatId, binding })
      addToast({ type: 'success', message: 'Preset and block states bound to this chat' })
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
      setChatSlot({ for: activeChatId, binding: null })
      addToast({ type: 'info', message: 'Chat binding removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove chat binding' })
    } finally {
      setIsLoading(false)
    }
  }, [activeChatId, addToast])

  // Bind to current character
  const bindToCharacter = useCallback(async () => {
    if (!presetId || !blocks || !activeCharacterId || isGroupChat) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.setCharacterBinding(activeCharacterId, presetId, snapshotBlockStates(blocks))
      setCharSlot({ for: activeCharacterId, binding })
      addToast({ type: 'success', message: 'Preset and block states bound to this character' })
    } catch {
      addToast({ type: 'error', message: 'Failed to bind to character' })
    } finally {
      setIsLoading(false)
    }
  }, [presetId, blocks, activeCharacterId, isGroupChat, addToast])

  // Unbind from current character
  const unbindCharacter = useCallback(async () => {
    if (!activeCharacterId || isGroupChat) return
    setIsLoading(true)
    try {
      await presetProfilesApi.deleteCharacterBinding(activeCharacterId)
      setCharSlot({ for: activeCharacterId, binding: null })
      addToast({ type: 'info', message: 'Character binding removed' })
    } catch {
      addToast({ type: 'error', message: 'Failed to remove character binding' })
    } finally {
      setIsLoading(false)
    }
  }, [activeCharacterId, isGroupChat, addToast])

  // Character bindings are skipped in group chats (per-member bindings are
  // ambiguous — backend resolveProfile applies the same gate).
  const characterBindingEnabled = !isGroupChat

  const resolvedPresetId = useMemo(() => {
    if (chatBinding) return chatBinding.preset_id
    if (characterBindingEnabled && characterBinding) return characterBinding.preset_id
    return presetId
  }, [chatBinding, characterBinding, characterBindingEnabled, presetId])

  // Resolved active binding (chat > character > defaults > none)
  const activeBinding = useMemo(() => {
    if (chatBinding) {
      if (chatBinding.linked_to_defaults) {
        return defaults && defaults.preset_id === chatBinding.preset_id ? defaults : null
      }
      return chatBinding
    }
    if (characterBindingEnabled && characterBinding) return characterBinding
    if (defaults) return defaults
    return null
  }, [chatBinding, characterBinding, defaults, characterBindingEnabled])

  // Determine active source
  const activeSource: 'chat' | 'character' | 'defaults' | 'none' = (() => {
    if (chatBinding) return 'chat'
    if (characterBindingEnabled && characterBinding) return 'character'
    if (defaults) return 'defaults'
    return 'none'
  })()

  const hasChatBinding = chatBinding !== null
  const hasCharacterBinding = characterBindingEnabled && characterBinding !== null

  const selectResolvedPreset = useCallback(() => {
    if (!resolvedPresetId || resolvedPresetId === presetId) return
    setActiveLoomPreset(resolvedPresetId)
  }, [resolvedPresetId, presetId, setActiveLoomPreset])

  return {
    // State
    hasDefaults,
    hasChatBinding,
    hasCharacterBinding,
    characterBindingEnabled,
    activeSource,
    activeBinding,
    resolvedPresetId,
    isResolved,
    isLoading,
    defaults,
    chatBinding,
    characterBinding,
    // Context the binding was resolved for — consumers include this in effect
    // deps so the apply-pass re-runs whenever the user switches chat/character,
    // even when the binding itself happens to be structurally unchanged.
    activeChatId,
    activeCharacterId,

    // Actions
    captureDefaults,
    clearDefaults,
    selectResolvedPreset,
    bindToChat,
    unbindChat,
    bindToCharacter,
    unbindCharacter,
  }
}
