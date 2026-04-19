import type { StateCreator } from 'zustand'
import type { GroupChatSlice } from '@/types/store'

export const createGroupChatSlice: StateCreator<GroupChatSlice> = (set, get) => ({
  isGroupChat: false,
  groupCharacterIds: [],
  mutedCharacterIds: [],
  roundCharactersSpoken: [],
  roundTotal: 0,
  currentRound: 0,
  isNudgeLoopActive: false,
  activeGroupCharacterId: null,
  mentionQueue: null,

  setGroupChat: (isGroup, characterIds, mutedIds) =>
    set({
      isGroupChat: isGroup,
      groupCharacterIds: characterIds,
      mutedCharacterIds: mutedIds ?? [],
      roundCharactersSpoken: [],
      roundTotal: 0,
      currentRound: 0,
      isNudgeLoopActive: false,
      activeGroupCharacterId: null,
      mentionQueue: null,
    }),

  clearGroupChat: () =>
    set({
      isGroupChat: false,
      groupCharacterIds: [],
      mutedCharacterIds: [],
      roundCharactersSpoken: [],
      roundTotal: 0,
      currentRound: 0,
      isNudgeLoopActive: false,
      activeGroupCharacterId: null,
      mentionQueue: null,
    }),

  markCharacterSpoken: (characterId) =>
    set((state) => ({
      roundCharactersSpoken: state.roundCharactersSpoken.includes(characterId)
        ? state.roundCharactersSpoken
        : [...state.roundCharactersSpoken, characterId],
    })),

  startNewRound: (total) =>
    set((state) => ({
      roundCharactersSpoken: [],
      roundTotal: total,
      currentRound: state.currentRound + 1,
    })),

  setNudgeLoopActive: (active) => set({ isNudgeLoopActive: active }),

  setActiveGroupCharacter: (characterId) => set({ activeGroupCharacterId: characterId }),

  setGroupCharacterIds: (ids) => set({ groupCharacterIds: ids }),

  setMutedCharacterIds: (ids) => set({ mutedCharacterIds: ids }),

  toggleMuteCharacter: (characterId) => {
    const current = get().mutedCharacterIds
    const newMuted = current.includes(characterId)
      ? current.filter((id) => id !== characterId)
      : [...current, characterId]
    set({ mutedCharacterIds: newMuted })
    return newMuted
  },

  setMentionQueue: (queue) => set({ mentionQueue: queue }),

  shiftMentionQueue: () => {
    const q = get().mentionQueue
    if (!q || q.ids.length === 0) return null
    const [head, ...rest] = q.ids
    set({ mentionQueue: rest.length > 0 ? { ...q, ids: rest } : null })
    return head
  },
})
