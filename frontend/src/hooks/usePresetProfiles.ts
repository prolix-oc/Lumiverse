import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { ApiError } from '@/api/client'
import { presetProfilesApi, type PresetProfileBinding } from '@/api/preset-profiles'
import { createPresetProfileSelectionController, type PresetProfileSelectionController } from './usePresetProfiles-selection'
import { createPresetProfileMutationCoordinator, runPresetProfileMutation, type PresetProfileMutationCoordinator } from './preset-profile-mutation-coordinator'
import {
  subscribePresetProfilePromptVariableChanges,
  updatePresetProfilePromptVariables,
} from './preset-profile-prompt-variables'
import type { PromptBlock, PromptVariableValues } from '@/lib/loom/types'
import { wsClient } from '@/ws/client'
import { EventType } from '@/ws/events'

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

function snapshotPromptVariables(values: PromptVariableValues | undefined): PromptVariableValues | undefined {
  return values ? structuredClone(values) : undefined
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
type PersonaSlot = { for: string | null; binding: PresetProfileBinding | null }
type CharSlot = { for: string | null; binding: PresetProfileBinding | null }
type ConnectionSlot = { for: string | null; binding: PresetProfileBinding | null }

const EMPTY_CHAT_SLOT: ChatSlot = { for: null, binding: null }
const EMPTY_PERSONA_SLOT: PersonaSlot = { for: null, binding: null }
const EMPTY_CHAR_SLOT: CharSlot = { for: null, binding: null }
const EMPTY_CONNECTION_SLOT: ConnectionSlot = { for: null, binding: null }
const profileScopes = {
  defaults: (id: string) => `defaults:${id}`,
  chat: (id: string) => `chat-binding:${id}`,
  persona: (id: string) => `persona-binding:${id}`,
  character: (id: string) => `character-binding:${id}`,
  connection: (id: string) => `connection-binding:${id}`,
}

export function usePresetProfiles(
  presetId: string | null,
  blocks: PromptBlock[] | undefined,
  promptVariables?: PromptVariableValues,
) {
  const { t } = useTranslation('panels', { keyPrefix: 'loomBuilder.toast' })
  const activeChatId = useStore((s) => s.activeChatId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const isGroupChat = useStore((s) => s.isGroupChat)
  const addToast = useStore((s) => s.addToast)

  const authUserId = useStore((s) => s.user?.id ?? null)
  const [defaults, setDefaults] = useState<PresetProfileBinding | null>(null)
  const [defaultsFor, setDefaultsFor] = useState<string | null>(null)
  const [chatSlot, setChatSlot] = useState<ChatSlot>(EMPTY_CHAT_SLOT)
  const [personaSlot, setPersonaSlot] = useState<PersonaSlot>(EMPTY_PERSONA_SLOT)
  const [charSlot, setCharSlot] = useState<CharSlot>(EMPTY_CHAR_SLOT)
  const [connectionSlot, setConnectionSlot] = useState<ConnectionSlot>(EMPTY_CONNECTION_SLOT)
  const [profileRevision, setProfileRevision] = useState(0)
  const presetIdRef = useRef(presetId)
  const authUserIdRef = useRef(authUserId)
  presetIdRef.current = presetId
  authUserIdRef.current = authUserId
  const activeChatIdRef = useRef(activeChatId)
  const activePersonaIdRef = useRef(activePersonaId)
  const activeCharacterIdRef = useRef(activeCharacterId)
  const activeProfileIdRef = useRef(activeProfileId)
  activeChatIdRef.current = activeChatId
  activePersonaIdRef.current = activePersonaId
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

  // Profile bindings are edited from more than one surface (the chat input
  // modal, Loom Builder, and other browser tabs). Keep this hook's scoped
  // binding cache authoritative by invalidating it whenever the backend
  // announces a profile change. Fetch tokens below discard any response that
  // was already in flight when this revision changed.
  useEffect(() => wsClient.on(EventType.PRESET_PROFILE_CHANGED, () => {
    setProfileRevision((revision) => revision + 1)
  }), [])
  useEffect(() => subscribePresetProfilePromptVariableChanges(() => {
    setProfileRevision((revision) => revision + 1)
  }), [])

  useEffect(() => {
    return () => {
      selectionControllerRef.current?.cancel()
      mutationCoordinator.invalidateMutations()
    }
  }, [activeChatId, activePersonaId, activeCharacterId, activeProfileId, presetId, authUserId, mutationCoordinator])

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
  }, [presetId, mutationCoordinator, profileRevision])

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
  }, [activeChatId, mutationCoordinator, profileRevision])

  // Load persona binding when the active persona changes. A persona profile
  // takes precedence over the character profile, mirroring backend resolution.
  useEffect(() => {
    const target = activePersonaId
    const scope = target ? profileScopes.persona(target) : null
    const fetchToken = scope ? mutationCoordinator.beginFetch(scope) : null
    if (!target) {
      setPersonaSlot(EMPTY_PERSONA_SLOT)
      return
    }
    let cancelled = false
    setPersonaSlot((prev) => (prev.for === target ? prev : EMPTY_PERSONA_SLOT))
    presetProfilesApi.getPersonaBinding(target)
      .then((b) => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setPersonaSlot({ for: target, binding: b })
        }
      })
      .catch(() => {
        if (!cancelled && scope && fetchToken && mutationCoordinator.isFetchCurrent(scope, fetchToken)) {
          setPersonaSlot({ for: target, binding: null })
        }
      })
    return () => { cancelled = true }
  }, [activePersonaId, mutationCoordinator, profileRevision])

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
  }, [activeCharacterId, mutationCoordinator, profileRevision])

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
  }, [activeProfileId, mutationCoordinator, profileRevision])

  // A binding is only considered current when it was fetched for the active id.
  const chatBinding = chatSlot.for === activeChatId ? chatSlot.binding : null
  const personaBinding = personaSlot.for === activePersonaId ? personaSlot.binding : null
  const characterBinding = charSlot.for === activeCharacterId ? charSlot.binding : null
  const connectionBinding = connectionSlot.for === activeProfileId ? connectionSlot.binding : null

  // isResolved: true when every applicable fetch has landed for the current
  // context. The LoomBuilder apply-effect waits on this so it doesn't overwrite
  // blocks with a stale binding mid-transition.
  const chatResolved = !activeChatId || chatSlot.for === activeChatId
  const personaResolved = !activePersonaId || personaSlot.for === activePersonaId
  const characterResolved = !activeCharacterId || charSlot.for === activeCharacterId
  const connectionResolved = !activeProfileId || connectionSlot.for === activeProfileId
  const defaultsResolved = !presetId || defaultsFor === presetId
  const isResolved = chatResolved && personaResolved && characterResolved && connectionResolved && defaultsResolved

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
        operation: () => presetProfilesApi.captureDefaults(targetPresetId, snapshot, snapshotPromptVariables(promptVariables)),
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
  }, [presetId, blocks, promptVariables, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

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
        operation: () => presetProfilesApi.setChatBinding(targetChatId, targetPresetId, snapshot, snapshotPromptVariables(promptVariables)),
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
  }, [presetId, blocks, promptVariables, activeChatId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

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

  // Bind to active persona
  const bindToPersona = useCallback(async () => {
    const targetPresetId = presetId
    const targetPersonaId = activePersonaId
    if (!targetPresetId || !blocks || !targetPersonaId) return
    const snapshot = snapshotBlockStates(blocks)
    const scope = profileScopes.persona(targetPersonaId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.setPersonaBinding(targetPersonaId, targetPresetId, snapshot, snapshotPromptVariables(promptVariables)),
        canStart: () => authUserIdRef.current === authUserId
          && presetIdRef.current === targetPresetId
          && activePersonaIdRef.current === targetPersonaId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getPersonaBinding(targetPersonaId)),
        isCurrent: (revision) => activePersonaIdRef.current === targetPersonaId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: (binding) => setPersonaSlot({ for: targetPersonaId, binding }),
        recover: (binding) => {
          if (activePersonaIdRef.current === targetPersonaId) setPersonaSlot({ for: targetPersonaId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'success', message: t('boundToPersona') })
      if (result === 'failed') addToast({ type: 'error', message: t('bindPersonaFailed') })
    } finally {
      endMutation()
    }
  }, [presetId, blocks, promptVariables, activePersonaId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

  const unbindPersona = useCallback(async () => {
    const targetPersonaId = activePersonaId
    if (!targetPersonaId) return
    const scope = profileScopes.persona(targetPersonaId)
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => presetProfilesApi.deletePersonaBinding(targetPersonaId),
        canStart: () => authUserIdRef.current === authUserId && activePersonaIdRef.current === targetPersonaId,
        refresh: () => refreshProfileBinding(presetProfilesApi.getPersonaBinding(targetPersonaId)),
        isCurrent: (revision) => activePersonaIdRef.current === targetPersonaId && mutationCoordinator.isMutationCurrent(scope, revision),
        commit: () => setPersonaSlot({ for: targetPersonaId, binding: null }),
        recover: (binding) => {
          if (activePersonaIdRef.current === targetPersonaId) setPersonaSlot({ for: targetPersonaId, binding })
        },
      })
      if (result === 'committed') addToast({ type: 'info', message: t('personaBindingRemoved') })
      if (result === 'failed') addToast({ type: 'error', message: t('removePersonaBindingFailed') })
    } finally {
      endMutation()
    }
  }, [activePersonaId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

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
        operation: () => presetProfilesApi.setCharacterBinding(targetCharacterId, targetPresetId, snapshot, snapshotPromptVariables(promptVariables)),
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
  }, [presetId, blocks, promptVariables, activeCharacterId, isGroupChat, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

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
        operation: () => presetProfilesApi.setConnectionBinding(targetProfileId, targetPresetId, snapshot, snapshotPromptVariables(promptVariables)),
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
  }, [presetId, blocks, promptVariables, activeProfileId, addToast, beginMutation, endMutation, mutationCoordinator, authUserId, t])

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
    if (personaBinding) return personaBinding.preset_id
    if (characterBindingEnabled && characterBinding) return characterBinding.preset_id
    if (connectionBinding) return connectionBinding.preset_id
    return presetId
  }, [chatBinding, personaBinding, characterBinding, characterBindingEnabled, connectionBinding, presetId])

  // A binding can disappear or fall back to the current preset without
  // changing the surrounding context ids. Retire an owned transition in that
  // no-op case; the controller does nothing when no profile transition exists,
  // so unrelated global selection requests remain untouched.
  useEffect(() => {
    if (!resolvedPresetId || resolvedPresetId === presetId) {
      selectionControllerRef.current?.select(resolvedPresetId, presetId)
    }
  }, [resolvedPresetId, presetId])

  // Resolved active binding (chat > persona > character > connection > defaults > none)
  const activeBinding = useMemo(() => {
    const currentDefaults = defaultsFor === presetId ? defaults : null
    if (chatBinding) {
      if (chatBinding.linked_to_defaults) {
        return currentDefaults && currentDefaults.preset_id === chatBinding.preset_id ? currentDefaults : null
      }
      return chatBinding
    }
    if (personaBinding) {
      if (personaBinding.linked_to_defaults) {
        return currentDefaults && currentDefaults.preset_id === personaBinding.preset_id ? currentDefaults : null
      }
      return personaBinding
    }
    if (characterBindingEnabled && characterBinding) return characterBinding
    if (connectionBinding) return connectionBinding
    if (currentDefaults) return currentDefaults
    return null
  }, [chatBinding, personaBinding, characterBinding, connectionBinding, defaults, defaultsFor, presetId, characterBindingEnabled])

  // Determine active source
  const activeSource: 'chat' | 'persona' | 'character' | 'connection' | 'defaults' | 'none' = (() => {
    if (chatBinding) return 'chat'
    if (personaBinding) return 'persona'
    if (characterBindingEnabled && characterBinding) return 'character'
    if (connectionBinding) return 'connection'
    if (defaultsFor === presetId && defaults) return 'defaults'
    return 'none'
  })()
  const activeSourceId = activeSource === 'chat' ? activeChatId
    : activeSource === 'persona' ? activePersonaId
      : activeSource === 'character' ? activeCharacterId
        : activeSource === 'connection' ? activeProfileId
          : activeSource === 'defaults' ? presetId
            : null

  // Save variable values into the resolved profile without rewriting the
  // binding's block-state snapshot. Returning false tells callers that no
  // profile is active and the base preset is therefore the correct target.
  const saveActivePromptVariableValues = useCallback(async (values: PromptVariableValues): Promise<boolean> => {
    if (!isResolved) throw new Error('The active preset profile is still resolving')
    const source = activeSource
    if (source === 'none') return false
    if (!activeBinding || !presetId || activeBinding.preset_id !== presetId) {
      throw new Error('The active preset profile is not resolved')
    }

    let targetId: string | null = null
    let scope = ''
    let refresh: () => Promise<PresetProfileBinding | null>
    let contextIsCurrent: () => boolean
    let commit: (binding: PresetProfileBinding) => void
    let recover: (binding: PresetProfileBinding | null) => void

    switch (source) {
      case 'chat': {
        targetId = activeChatId
        if (!targetId || !chatBinding) throw new Error('The active chat profile is not resolved')
        const targetChatId = targetId
        const writesDefaults = !!chatBinding.linked_to_defaults
        scope = profileScopes.chat(targetChatId)
        refresh = () => refreshProfileBinding(presetProfilesApi.getChatBinding(targetChatId))
        contextIsCurrent = () => activeChatIdRef.current === targetChatId
        commit = (binding) => {
          if (writesDefaults) {
            setDefaults(binding)
            setDefaultsFor(binding.preset_id)
          } else {
            setChatSlot({ for: targetChatId, binding })
          }
        }
        recover = (binding) => setChatSlot({ for: targetChatId, binding })
        break
      }
      case 'persona': {
        targetId = activePersonaId
        if (!targetId || !personaBinding) throw new Error('The active persona profile is not resolved')
        const targetPersonaId = targetId
        const writesDefaults = !!personaBinding.linked_to_defaults
        scope = profileScopes.persona(targetPersonaId)
        refresh = () => refreshProfileBinding(presetProfilesApi.getPersonaBinding(targetPersonaId))
        contextIsCurrent = () => activePersonaIdRef.current === targetPersonaId
        commit = (binding) => {
          if (writesDefaults) {
            setDefaults(binding)
            setDefaultsFor(binding.preset_id)
          } else {
            setPersonaSlot({ for: targetPersonaId, binding })
          }
        }
        recover = (binding) => setPersonaSlot({ for: targetPersonaId, binding })
        break
      }
      case 'character': {
        targetId = activeCharacterId
        if (!targetId || !characterBinding) throw new Error('The active character profile is not resolved')
        const targetCharacterId = targetId
        scope = profileScopes.character(targetCharacterId)
        refresh = () => refreshProfileBinding(presetProfilesApi.getCharacterBinding(targetCharacterId))
        contextIsCurrent = () => activeCharacterIdRef.current === targetCharacterId
        commit = (binding) => setCharSlot({ for: targetCharacterId, binding })
        recover = (binding) => setCharSlot({ for: targetCharacterId, binding })
        break
      }
      case 'connection': {
        targetId = activeProfileId
        if (!targetId || !connectionBinding) throw new Error('The active connection profile is not resolved')
        const targetProfileId = targetId
        scope = profileScopes.connection(targetProfileId)
        refresh = () => refreshProfileBinding(presetProfilesApi.getConnectionBinding(targetProfileId))
        contextIsCurrent = () => activeProfileIdRef.current === targetProfileId
        commit = (binding) => setConnectionSlot({ for: targetProfileId, binding })
        recover = (binding) => setConnectionSlot({ for: targetProfileId, binding })
        break
      }
      case 'defaults': {
        targetId = presetId
        const targetPresetId = targetId
        scope = profileScopes.defaults(targetPresetId)
        refresh = () => refreshProfileBinding(presetProfilesApi.getDefaults(targetPresetId))
        contextIsCurrent = () => presetIdRef.current === targetPresetId
        commit = (binding) => {
          setDefaults(binding)
          setDefaultsFor(targetPresetId)
        }
        recover = (binding) => {
          setDefaults(binding)
          setDefaultsFor(targetPresetId)
        }
        break
      }
    }

    const target = { source, id: targetId }
    beginMutation()
    try {
      const result = await runPresetProfileMutation({
        coordinator: mutationCoordinator,
        scope,
        operation: () => updatePresetProfilePromptVariables(presetProfilesApi, target, values),
        authorityCommittedByOperation: true,
        canStart: () => authUserIdRef.current === authUserId
          && presetIdRef.current === presetId
          && contextIsCurrent(),
        refresh,
        isCurrent: (revision) => contextIsCurrent() && mutationCoordinator.isMutationCurrent(scope, revision),
        commit,
        recover,
      })
      if (result === 'failed') throw new Error('Failed to save profile prompt variables')
      return true
    } finally {
      endMutation()
    }
  }, [
    activeSource,
    isResolved,
    activeBinding,
    presetId,
    activeChatId,
    activePersonaId,
    activeCharacterId,
    activeProfileId,
    chatBinding,
    personaBinding,
    characterBinding,
    connectionBinding,
    authUserId,
    beginMutation,
    endMutation,
    mutationCoordinator,
  ])

  const hasChatBinding = chatBinding !== null
  const hasPersonaBinding = personaBinding !== null
  const hasCharacterBinding = characterBindingEnabled && characterBinding !== null
  const hasConnectionBinding = connectionBinding !== null

  const selectResolvedPreset = useCallback(() => {
    return selectionControllerRef.current?.select(resolvedPresetId, presetId) ?? null
  }, [resolvedPresetId, presetId])

  return {
    // State
    hasDefaults,
    hasChatBinding,
    hasPersonaBinding,
    hasCharacterBinding,
    hasConnectionBinding,
    characterBindingEnabled,
    activeSource,
    activeSourceId,
    activeBinding,
    resolvedPresetId,
    isResolved,
    isLoading,
    defaults,
    chatBinding,
    personaBinding,
    characterBinding,
    connectionBinding,
    // Context the binding was resolved for — consumers include this in effect
    // deps so the apply-pass re-runs whenever the user switches chat/character,
    // even when the binding itself happens to be structurally unchanged.
    activeChatId,
    activePersonaId,
    activeCharacterId,
    activeProfileId,

    // Actions
    captureDefaults,
    clearDefaults,
    saveActivePromptVariableValues,
    selectResolvedPreset,
    bindToChat,
    unbindChat,
    bindToPersona,
    unbindPersona,
    bindToCharacter,
    unbindCharacter,
    bindToConnection,
    unbindConnection,
  }
}
