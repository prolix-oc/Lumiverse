import type { StateCreator } from 'zustand'
import type { GroupChatSlice } from '@/types/store'

export const createGroupChatSlice: StateCreator<GroupChatSlice> = (set) => ({
  isGroupChat: false,
  groupCharacterIds: [],
  roundCharactersSpoken: [],
  roundTotal: 0,
  currentRound: 0,
  isNudgeLoopActive: false,
  activeGroupCharacterId: null,

  setGroupChat: (isGroup, characterIds) =>
    set({
      isGroupChat: isGroup,
      groupCharacterIds: characterIds,
      roundCharactersSpoken: [],
      roundTotal: 0,
      currentRound: 0,
      isNudgeLoopActive: false,
      activeGroupCharacterId: null,
    }),

  clearGroupChat: () =>
    set({
      isGroupChat: false,
      groupCharacterIds: [],
      roundCharactersSpoken: [],
      roundTotal: 0,
      currentRound: 0,
      isNudgeLoopActive: false,
      activeGroupCharacterId: null,
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
})
