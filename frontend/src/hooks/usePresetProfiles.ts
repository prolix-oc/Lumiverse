import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { ApiError } from '@/api/client'
import { presetProfilesApi, type PresetProfileBinding } from '@/api/preset-profiles'
import { createPresetProfileSelectionController, type PresetProfileSelectionController } from './usePresetProfiles-selection'
import { createPresetProfileMutationCoordinator, runPresetProfileMutation, type PresetProfileMutationCoordinator } from './preset-profile-mutation-coordinator'
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

function refreshProfileBinding(
  request: Promise<PresetProfileBinding>,
): Promise<PresetProfileBinding | null> {
  return request.catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null
    throw error
  })
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
const profileScopes = {
  defaults: (id: string) => `defaults:${id}`,
  chat: (id: string) => `chat-binding:${id}`,
  character: (id: string) => `character-binding:${id}`,
  connection: (id: string) => `connection-binding:${id}`,
}

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

  const authUserId = useStore((s) => s.user?.id ?? null)
  const [defaults, setDefaults] = useState<PresetProfileBinding | null>(null)
  const [defaultsFor, setDefaultsFor] = useState<string | null>(null)
  const [chatSlot, setChatSlot] = useState<ChatSlot>(EMPTY_CHAT_SLOT)
  const [charSlot, setCharSlot] = useState<CharSlot>(EMPTY_CHAR_SLOT)
  const [connectionSlot, setConnectionSlot] = useState<ConnectionSlot>(EMPTY_CONNECTION_SLOT)
  const presetIdRef = useRef(presetId)
  const authUserIdRef = useRef(authUserId)
  presetIdRef.current = presetId
  authUserIdRef.current = authUserId
  const activeChatIdRef = useRef(activeChatId)
  const activeCharacterIdRef = useRef(activeCharacterId)
  const activeProfileIdRef = useRef(activeProfileId)
  activeChatIdRef.current = activeChatId
  activeCharacterIdRef.current = activeCharacterId
  activeProfileIdRef.current = activeProfileId
  const mutationCoordinatorRef = useRef<PresetProfileMutationCoordinator | null>(null)
  if (!mutationCoordinatorRef.current) {
    mutationCoordinatorRef.current = createPresetProfileMutationCoordinator()
  }
  const mutationCoordinator = mutationCoordinatorRef.current!
  const [isLoading, setIsLoading] = useState(false)
  const mutationCountRef = useRef(0)
  const beginMutation = useCallback(() => {
    mutationCountRef.current += 1
    setIsLoading(true)
  }, [])
  const endMutation = useCallback(() => {
    mutationCountRef.current = Math.max(0, mutationCountRef.current - 1)
    setIsLoading(mutationCountRef.current > 0)
  }, [])
  const selectionControllerRef = useRef<PresetProfileSelectionController | null>(null)
  if (!selectionControllerRef.current) {
    selectionControllerRef.current = createPresetProfileSelectionController()
  }

  useEffect(() => {
    return () => {
      selectionControllerRef.current?.cancel()
      mutationCoordinator.invalidateMutations()
    }
  }, [activeChatId, activeCharacterId, activeProfileId, presetId, authUserId, mutationCoordinator])

  // Load defaults for the currently selected preset. Defaults are stored per
  // preset, so switching presets should load a different default snapshot.
  useEffect(() => {
    const targetPresetId = presetId
    const scope = targetPresetId ? profileScopes.defaults(targetPresetId) : null
    const fetchToken = scope ? mutationCoordinator.beginFetch(scope) : null
    setDefaults(null)
    setDefaultsFor(null)
    if (!targetPresetId || !scope || !fetchToken) return
    let cancelled = false
    presetProfilesApi.getDefaults(targetPresetId)
      .then((d) => {
        if (cancelled || !mutationCoordinator.isFetchCurrent(scope, fetchToken)) return
        setDefaults(d)
        setDefaultsFor(targetPresetId)
      })
      .catch(() => {
        if (cancelled || !mutationCoordinator.isFetchCurrent(scope, fetchToken)) return
        setDefaults(null)
        setDefaultsFor(targetPresetId)
      })
    return () => { cancelled = true }
  }, [presetId, mutationCoordinator])

  // Load chat binding when chat changes. Stale fetches are discarded by the
  // cancelled flag, and the slot is keyed by the chat id it was fetched for so
  // downstream consumers can tell whether it's fresh for the current chat.
  useEffect(() => {
    const target = activeChatId
    const scope = target ? profileScopes.chat(target) : null
    const fetchToken = scope ? mutationCoordinator.beginFetch(scope) : null
    if (!target) {
      setChatSlot(EMPTY_CHAT_SLOT)
      return
    }
    let cancelled = false
    setChatSlot((prev) => (prev.for === target ? prev : EMPTY_CHAT_SLOT))
    presetProfilesApi.getChatBinding(target)
      .then((b) => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setChatSlot({ for: target, binding: b })
        }
      })
      .catch(() => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setChatSlot({ for: target, binding: null })
        }
      })
    return () => { cancelled = true }
  }, [activeChatId, mutationCoordinator])

  // Load character binding when character changes (same pattern as chat).
  useEffect(() => {
    const target = activeCharacterId
    const scope = target ? profileScopes.character(target) : null
    const fetchToken = scope ? mutationCoordinator.beginFetch(scope) : null
    if (!target) {
      setCharSlot(EMPTY_CHAR_SLOT)
      return
    }
    let cancelled = false
    setCharSlot((prev) => (prev.for === target ? prev : EMPTY_CHAR_SLOT))
    presetProfilesApi.getCharacterBinding(target)
      .then((b) => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setCharSlot({ for: target, binding: b })
        }
      })
      .catch(() => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setCharSlot({ for: target, binding: null })
        }
      })
    return () => { cancelled = true }
  }, [activeCharacterId, mutationCoordinator])

  // Load connection profile binding when active connection changes.
  useEffect(() => {
    const target = activeProfileId
    const scope = target ? profileScopes.connection(target) : null
    const fetchToken = scope ? mutationCoordinator.beginFetch(scope) : null
    if (!target) {
      setConnectionSlot(EMPTY_CONNECTION_SLOT)
      return
    }
    let cancelled = false
    setConnectionSlot((prev) => (prev.for === target ? prev : EMPTY_CONNECTION_SLOT))
    presetProfilesApi.getConnectionBinding(target)
      .then((b) => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setConnectionSlot({ for: target, binding: b })
        }
      })
      .catch(() => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setConnectionSlot({ for: target, binding: null })
        }
      })
    return () => { cancelled = true }
  }, [activeProfileId, mutationCoordinator])

  // A binding is only considered current when it was fetched for the active id.
  const chatBinding = chatSlot.for === activeChatId ? chatSlot.binding : null
  const characterBinding = charSlot.for === activeCharacterId ? charSlot.binding : null
  const connectionBinding = connectionSlot.for === activeProfileId ? connectionSlot.binding : null

  // isResolved: true when every applicable fetch has landed for the current
  // context. The LoomBuilder apply-effect waits on this so it doesn't overwrite
  // blocks with a stale binding mid-transition.
  const chatResolved = !activeChatId || chatSlot.for === activeChatId
  const characterResolved = !activeCharacterId || charSlot.for === activeCharacterId
  const connectionResolved = !activeProfileId || connectionSlot.for === activeProfileId
  const defaultsResolved = !presetId || defaultsFor === presetId
  const isResolved = chatResolved && characterResolved && connectionResolved && defaultsResolved

  const hasDefaults = defaultsFor === presetId && defaults !== null

  // Capture defaults
  const captureDefaults = useCallback(async () => {
    const targetPresetId = presetId
    if (!targetPresetId || !blocks) return
    const snapshot = snapshotBlockStates(blocks)
    const scope = profileScopes.defaults(targetPresetId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.captureDefaults(targetPresetId, snapshot),
        canStart: () => authUserIdRef.current === authUserId && presetIdRef.current === targetPresetId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getDefaults(targetPresetId)),
        isCurrent: (revision) => presetIdRef.current === targetPresetId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: (binding) => {
          setDefaults(binding)
          setDefaultsFor(targetPresetId)
        },
        recover: (binding) => {
          if (presetIdRef.current === targetPresetId) {
            setDefaults(binding)
            setDefaultsFor(targetPresetId)
          }
        },
      })
      if (result === 'committed') addToast({ type: 'success', message: t('defaultsCaptured') })
      if (result === 'failed') addToast({ type: 'error', message: t('captureDefaultsFailed') })
    } finally {
      endMutation()
    }
  }, [presetId, blocks, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  // Clear defaults
  const clearDefaults = useCallback(async () => {
    const targetPresetId = presetId
    if (!targetPresetId) return
    const scope = profileScopes.defaults(targetPresetId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.deleteDefaults(targetPresetId),
        canStart: () => authUserIdRef.current === authUserId && presetIdRef.current === targetPresetId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getDefaults(targetPresetId)),
        isCurrent: (revision) => presetIdRef.current === targetPresetId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: () => {
          setDefaults(null)
          setDefaultsFor(targetPresetId)
        },
        recover: (binding) => {
          if (presetIdRef.current === targetPresetId) {
            setDefaults(binding)
            setDefaultsFor(targetPresetId)
          }
        },
      })
      if (result === 'committed') addToast({ type: 'info', message: t('defaultsCleared') })
      if (result === 'failed') addToast({ type: 'error', message: t('clearDefaultsFailed') })
    } finally {
      endMutation()
    }
  }, [presetId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  // Bind to current chat
  const bindToChat = useCallback(async () => {
    const targetPresetId = presetId
    const targetChatId = activeChatId
    if (!targetPresetId || !blocks || !targetChatId) return
    const snapshot = snapshotBlockStates(blocks)
    const scope = profileScopes.chat(targetChatId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.setChatBinding(targetChatId, targetPresetId, snapshot),
        canStart: () => authUserIdRef.current === authUserId
          && presetIdRef.current === targetPresetId
          && activeChatIdRef.current === targetChatId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getChatBinding(targetChatId)),
        isCurrent: (revision) => activeChatIdRef.current === targetChatId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: (binding) => setChatSlot({ for: targetChatId, binding }),
        recover: (binding) => {
          if (activeChatIdRef.current === targetChatId) setChatSlot({ for: targetChatId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'success', message: t('boundToChat') })
      if (result === 'failed') addToast({ type: 'error', message: t('bindChatFailed') })
    } finally {
      endMutation()
    }
  }, [presetId, blocks, activeChatId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  // Unbind from current chat
  const unbindChat = useCallback(async () => {
    const targetChatId = activeChatId
    if (!targetChatId) return
    const scope = profileScopes.chat(targetChatId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.deleteChatBinding(targetChatId),
        canStart: () => authUserIdRef.current === authUserId && activeChatIdRef.current === targetChatId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getChatBinding(targetChatId)),
        isCurrent: (revision) => activeChatIdRef.current === targetChatId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: () => setChatSlot({ for: targetChatId, binding: null }),
        recover: (binding) => {
          if (activeChatIdRef.current === targetChatId) setChatSlot({ for: targetChatId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'info', message: t('chatBindingRemoved') })
      if (result === 'failed') addToast({ type: 'error', message: t('removeChatBindingFailed') })
    } finally {
      endMutation()
    }
  }, [activeChatId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])
  const bindToCharacter = useCallback(async () => {
    const targetPresetId = presetId
    const targetCharacterId = activeCharacterId
    if (!targetPresetId || !blocks || !targetCharacterId || isGroupChat) return
    const snapshot = snapshotBlockStates(blocks)
    const scope = profileScopes.character(targetCharacterId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.setCharacterBinding(targetCharacterId, targetPresetId, snapshot),
        canStart: () => authUserIdRef.current === authUserId
          && presetIdRef.current === targetPresetId
          && activeCharacterIdRef.current === targetCharacterId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getCharacterBinding(targetCharacterId)),
        isCurrent: (revision) => activeCharacterIdRef.current === targetCharacterId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: (binding) => setCharSlot({ for: targetCharacterId, binding }),
        recover: (binding) => {
          if (activeCharacterIdRef.current === targetCharacterId) setCharSlot({ for: targetCharacterId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'success', message: t('boundToCharacter') })
      if (result === 'failed') addToast({ type: 'error', message: t('bindCharacterFailed') })
    } finally {
      endMutation()
    }
  }, [presetId, blocks, activeCharacterId, isGroupChat, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  // Unbind from current character
  const unbindCharacter = useCallback(async () => {
    const targetCharacterId = activeCharacterId
    if (!targetCharacterId || isGroupChat) return
    const scope = profileScopes.character(targetCharacterId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.deleteCharacterBinding(targetCharacterId),
        canStart: () => authUserIdRef.current === authUserId && activeCharacterIdRef.current === targetCharacterId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getCharacterBinding(targetCharacterId)),
        isCurrent: (revision) => activeCharacterIdRef.current === targetCharacterId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: () => setCharSlot({ for: targetCharacterId, binding: null }),
        recover: (binding) => {
          if (activeCharacterIdRef.current === targetCharacterId) setCharSlot({ for: targetCharacterId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'info', message: t('characterBindingRemoved') })
      if (result === 'failed') addToast({ type: 'error', message: t('removeCharacterBindingFailed') })
    } finally {
      endMutation()
    }
  }, [activeCharacterId, isGroupChat, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])
  // Bind to current connection profile
  const bindToConnection = useCallback(async () => {
    const targetPresetId = presetId
    const targetProfileId = activeProfileId
    if (!targetPresetId || !blocks || !targetProfileId) return
    const snapshot = snapshotBlockStates(blocks)
    const scope = profileScopes.connection(targetProfileId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.setConnectionBinding(targetProfileId, targetPresetId, snapshot),
        canStart: () => authUserIdRef.current === authUserId
          && presetIdRef.current === targetPresetId
          && activeProfileIdRef.current === targetProfileId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getConnectionBinding(targetProfileId)),
        isCurrent: (revision) => activeProfileIdRef.current === targetProfileId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: (binding) => setConnectionSlot({ for: targetProfileId, binding }),
        recover: (binding) => {
          if (activeProfileIdRef.current === targetProfileId) setConnectionSlot({ for: targetProfileId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'success', message: t('boundToConnection') })
      if (result === 'failed') addToast({ type: 'error', message: t('bindConnectionFailed') })
    } finally {
      endMutation()
    }
  }, [presetId, blocks, activeProfileId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  // Unbind from current connection profile
  const unbindConnection = useCallback(async () => {
    const targetProfileId = activeProfileId
    if (!targetProfileId) return
    const scope = profileScopes.connection(targetProfileId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.deleteConnectionBinding(targetProfileId),
        canStart: () => authUserIdRef.current === authUserId && activeProfileIdRef.current === targetProfileId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getConnectionBinding(targetProfileId)),
        isCurrent: (revision) => activeProfileIdRef.current === targetProfileId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: () => setConnectionSlot({ for: targetProfileId, binding: null }),
        recover: (binding) => {
          if (activeProfileIdRef.current === targetProfileId) setConnectionSlot({ for: targetProfileId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'info', message: t('connectionBindingRemoved') })
      if (result === 'failed') addToast({ type: 'error', message: t('removeConnectionBindingFailed') })
    } finally {
      endMutation()
    }
  }, [activeProfileId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  // Character bindings are skipped in group chats (per-member bindings are
  // ambiguous — backend resolveProfile applies the same gate).
  const characterBindingEnabled = !isGroupChat

  const resolvedPresetId = useMemo(() => {
    if (chatBinding) return chatBinding.preset_id
    if (characterBindingEnabled && characterBinding) return characterBinding.preset_id
    if (connectionBinding) return connectionBinding.preset_id
    return presetId
  }, [chatBinding, characterBinding, characterBindingEnabled, connectionBinding, presetId])

  // A binding can disappear or fall back to the current preset without
  // changing the surrounding context ids. Retire an owned transition in that
  // no-op case; the controller does nothing when no profile transition exists,
  // so unrelated global selection requests remain untouched.
  useEffect(() => {
    if (!resolvedPresetId || resolvedPresetId === presetId) {
      selectionControllerRef.current?.select(resolvedPresetId, presetId)
    }
  }, [resolvedPresetId, presetId])

  // Resolved active binding (chat > character > connection > defaults > none)
  const activeBinding = useMemo(() => {
    const currentDefaults = defaultsFor === presetId ? defaults : null
    if (chatBinding) {
      if (chatBinding.linked_to_defaults) {
        return currentDefaults && currentDefaults.preset_id === chatBinding.preset_id ? currentDefaults : null
      }
      return chatBinding
    }
    if (characterBindingEnabled && characterBinding) return characterBinding
    if (connectionBinding) return connectionBinding
    if (currentDefaults) return currentDefaults
    return null
  }, [chatBinding, characterBinding, connectionBinding, defaults, defaultsFor, presetId, characterBindingEnabled])

  // Determine active source
  const activeSource: 'chat' | 'character' | 'connection' | 'defaults' | 'none' = (() => {
    if (chatBinding) return 'chat'
    if (characterBindingEnabled && characterBinding) return 'character'
    if (connectionBinding) return 'connection'
    if (defaultsFor === presetId && defaults) return 'defaults'
    return 'none'
  })()

  const hasChatBinding = chatBinding !== null
  const hasCharacterBinding = characterBindingEnabled && characterBinding !== null
  const hasConnectionBinding = connectionBinding !== null

  const selectResolvedPreset = useCallback(() => {
    return selectionControllerRef.current?.select(resolvedPresetId, presetId) ?? null
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
