import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { presetProfilesApi, type PresetProfileBinding } from '@/api/preset-profiles'
import { beginActiveLoomPresetSelection, type PresetSelectionRequest } from '@/lib/loom/preset-selection-coordinator'
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
type ConnectionSlot = { for: string | null; binding: PresetProfileBinding | null }

const EMPTY_CHAT_SLOT: ChatSlot = { for: null, binding: null }
const EMPTY_CHAR_SLOT: CharSlot = { for: null, binding: null }
const EMPTY_CONNECTION_SLOT: ConnectionSlot = { for: null, binding: null }

export function usePresetProfiles(
  presetId: string | null,
  blocks: PromptBlock[] | undefined,
) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.toast' })
  const activeChatId = useStore((s) => s.activeChatId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const addToast = useStore((s) => s.addToast)

  const [defaults, setDefaults] = useState<PresetProfileBinding | null>(null)
  const [chatSlot, setChatSlot] = useState<ChatSlot>(EMPTY_CHAT_SLOT)
  const [charSlot, setCharSlot] = useState<CharSlot>(EMPTY_CHAR_SLOT)
  const [connectionSlot, setConnectionSlot] = useState<ConnectionSlot>(EMPTY_CONNECTION_SLOT)
  const [isLoading, setIsLoading] = useState(false)
  const selectionIntentRef = useRef<PresetSelectionRequest | null>(null)

  useEffect(() => {
    selectionIntentRef.current?.cancel()
    const selectionIntent = beginActiveLoomPresetSelection()
    selectionIntentRef.current = selectionIntent
    return () => {
      selectionIntent.cancel()
      if (selectionIntentRef.current === selectionIntent) {
        selectionIntentRef.current = null
      }
    }
  }, [activeChatId, activeCharacterId, activeProfileId, presetId])


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

  // Load connection profile binding when active connection changes.
  useEffect(() => {
    if (!activeProfileId) {
      setConnectionSlot(EMPTY_CONNECTION_SLOT)
      return
    }
    const target = activeProfileId
    let cancelled = false
    setConnectionSlot((prev) => (prev.for === target ? prev : EMPTY_CONNECTION_SLOT))
    presetProfilesApi.getConnectionBinding(target)
      .then((b) => { if (!cancelled) setConnectionSlot({ for: target, binding: b }) })
      .catch(() => { if (!cancelled) setConnectionSlot({ for: target, binding: null }) })
    return () => { cancelled = true }
  }, [activeProfileId])

  // A binding is only considered "for" the current context if its `for` id
  // still matches the store's active id. Anything else is stale.
  const chatBinding = chatSlot.for === activeChatId ? chatSlot.binding : null
  const characterBinding = charSlot.for === activeCharacterId ? charSlot.binding : null
  const connectionBinding = connectionSlot.for === activeProfileId ? connectionSlot.binding : null

  // isResolved: true when every applicable fetch has landed for the current
  // context. The LoomBuilder apply-effect waits on this so it doesn't overwrite
  // blocks with a stale binding mid-transition.
  const chatResolved = !activeChatId || chatSlot.for === activeChatId
  const characterResolved = !activeCharacterId || charSlot.for === activeCharacterId
  const connectionResolved = !activeProfileId || connectionSlot.for === activeProfileId
  const isResolved = chatResolved && characterResolved && connectionResolved

  const hasDefaults = defaults !== null

  // Capture defaults
  const captureDefaults = useCallback(async () => {
    if (!presetId || !blocks) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.captureDefaults(presetId, snapshotBlockStates(blocks))
      setDefaults(binding)
      addToast({ type: 'success', message: t('defaultsCaptured') })
    } catch {
      addToast({ type: 'error', message: t('captureDefaultsFailed') })
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
      addToast({ type: 'info', message: t('defaultsCleared') })
    } catch {
      addToast({ type: 'error', message: t('clearDefaultsFailed') })
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
      addToast({ type: 'success', message: t('boundToChat') })
    } catch {
      addToast({ type: 'error', message: t('bindChatFailed') })
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
      addToast({ type: 'info', message: t('chatBindingRemoved') })
    } catch {
      addToast({ type: 'error', message: t('removeChatBindingFailed') })
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
      addToast({ type: 'success', message: t('boundToCharacter') })
    } catch {
      addToast({ type: 'error', message: t('bindCharacterFailed') })
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
      addToast({ type: 'info', message: t('characterBindingRemoved') })
    } catch {
      addToast({ type: 'error', message: t('removeCharacterBindingFailed') })
    } finally {
      setIsLoading(false)
    }
  }, [activeCharacterId, isGroupChat, addToast])

  // Bind to current connection profile
  const bindToConnection = useCallback(async () => {
    if (!presetId || !blocks || !activeProfileId) return
    setIsLoading(true)
    try {
      const binding = await presetProfilesApi.setConnectionBinding(activeProfileId, presetId, snapshotBlockStates(blocks))
      setConnectionSlot({ for: activeProfileId, binding })
      addToast({ type: 'success', message: t('boundToConnection') })
    } catch {
      addToast({ type: 'error', message: t('bindConnectionFailed') })
    } finally {
      setIsLoading(false)
    }
  }, [presetId, blocks, activeProfileId, addToast])

  // Unbind from current connection profile
  const unbindConnection = useCallback(async () => {
    if (!activeProfileId) return
    setIsLoading(true)
    try {
      await presetProfilesApi.deleteConnectionBinding(activeProfileId)
      setConnectionSlot({ for: activeProfileId, binding: null })
      addToast({ type: 'info', message: t('connectionBindingRemoved') })
    } catch {
      addToast({ type: 'error', message: t('removeConnectionBindingFailed') })
    } finally {
      setIsLoading(false)
    }
  }, [activeProfileId, addToast])

  // Character bindings are skipped in group chats (per-member bindings are
  // ambiguous — backend resolveProfile applies the same gate).
  const characterBindingEnabled = !isGroupChat

  const resolvedPresetId = useMemo(() => {
    if (chatBinding) return chatBinding.preset_id
    if (characterBindingEnabled && characterBinding) return characterBinding.preset_id
    if (connectionBinding) return connectionBinding.preset_id
    return presetId
  }, [chatBinding, characterBinding, characterBindingEnabled, connectionBinding, presetId])

  // Resolved active binding (chat > character > connection > defaults > none)
  const activeBinding = useMemo(() => {
    if (chatBinding) {
      if (chatBinding.linked_to_defaults) {
        return defaults && defaults.preset_id === chatBinding.preset_id ? defaults : null
      }
      return chatBinding
    }
    if (characterBindingEnabled && characterBinding) return characterBinding
    if (connectionBinding) return connectionBinding
    if (defaults) return defaults
    return null
  }, [chatBinding, characterBinding, connectionBinding, defaults, characterBindingEnabled])

  // Determine active source
  const activeSource: 'chat' | 'character' | 'connection' | 'defaults' | 'none' = (() => {
    if (chatBinding) return 'chat'
    if (characterBindingEnabled && characterBinding) return 'character'
    if (connectionBinding) return 'connection'
    if (defaults) return 'defaults'
    return 'none'
  })()

  const hasChatBinding = chatBinding !== null
  const hasCharacterBinding = characterBindingEnabled && characterBinding !== null
  const hasConnectionBinding = connectionBinding !== null

  const selectResolvedPreset = useCallback(() => {
    if (!resolvedPresetId || resolvedPresetId === presetId) return
    const selection = selectionIntentRef.current ?? beginActiveLoomPresetSelection()
    selectionIntentRef.current = selection
    void selection.transition(resolvedPresetId)
      .catch(() => {})
      .finally(() => {
        if (selectionIntentRef.current === selection) {
          selectionIntentRef.current = null
        }
      })
  }, [resolvedPresetId, presetId])

  return {
    // State
    hasDefaults,
    hasChatBinding,
    hasCharacterBinding,
    hasConnectionBinding,
    characterBindingEnabled,
    activeSource,
    activeBinding,
    resolvedPresetId,
    isResolved,
    isLoading,
    defaults,
    chatBinding,
    characterBinding,
    connectionBinding,
    // Context the binding was resolved for — consumers include this in effect
    // deps so the apply-pass re-runs whenever the user switches chat/character,
    // even when the binding itself happens to be structurally unchanged.
    activeChatId,
    activeCharacterId,
    activeProfileId,

    // Actions
    captureDefaults,
    clearDefaults,
    selectResolvedPreset,
    bindToChat,
    unbindChat,
    bindToCharacter,
    unbindCharacter,
    bindToConnection,
    unbindConnection,
  }
}
