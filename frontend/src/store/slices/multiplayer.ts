import type { StateCreator } from 'zustand'
import type { MultiplayerSlice } from '@/types/store'
import type { RoomParticipant } from '@/types/multiplayer'

const EMPTY = {
  mpRoomId: null,
  mpChatId: null,
  mpIsHost: false,
  mpMyParticipantId: null,
  mpConnStatus: 'idle' as const,
  mpParticipants: [] as RoomParticipant[],
  mpTurnStrategy: 'round_robin' as const,
  mpCurrentTurnParticipantId: null,
  mpTurnOrder: [] as string[],
  mpRound: 0,
  mpFreeformDeadline: null,
  mpSettings: null,
  mpCharacterAvatar: null as string | null,
  mpRemoteCode: null as string | null,
}

/** Recompute each participant's isCurrentTurn flag from the single source of truth. */
function withTurnFlags(participants: RoomParticipant[], currentId: string | null): RoomParticipant[] {
  return participants.map((p) => ({ ...p, isCurrentTurn: p.id === currentId }))
}

export const createMultiplayerSlice: StateCreator<MultiplayerSlice> = (set, get) => ({
  ...EMPTY,

  setRoomState: (view, opts) =>
    set({
      mpRoomId: view.roomId,
      mpChatId: view.chatId,
      mpIsHost: opts?.isHost ?? get().mpIsHost,
      mpMyParticipantId: view.selfParticipantId ?? get().mpMyParticipantId,
      mpConnStatus: 'connected',
      mpParticipants: withTurnFlags(view.participants, view.currentTurnParticipantId),
      mpTurnStrategy: view.turnStrategy,
      mpCurrentTurnParticipantId: view.currentTurnParticipantId,
      mpTurnOrder: view.turnOrder,
      mpRound: view.round,
      mpFreeformDeadline: view.freeformDeadline,
      mpSettings: view.settings ?? get().mpSettings,
    }),

  clearRoom: () => set({ ...EMPTY }),

  setRoomConnStatus: (status) => set({ mpConnStatus: status }),

  setCharacterAvatar: (url) => set({ mpCharacterAvatar: url }),

  setRemoteCode: (code) => set({ mpRemoteCode: code }),

  upsertParticipant: (participant) =>
    set((state) => {
      const exists = state.mpParticipants.some((p) => p.id === participant.id)
      const next = exists
        ? state.mpParticipants.map((p) => (p.id === participant.id ? { ...p, ...participant } : p))
        : [...state.mpParticipants, participant]
      return { mpParticipants: withTurnFlags(next, state.mpCurrentTurnParticipantId) }
    }),

  removeParticipant: (participantId) =>
    set((state) => ({
      mpParticipants: state.mpParticipants.filter((p) => p.id !== participantId),
    })),

  setParticipantPersona: (participantId, persona) =>
    set((state) => ({
      mpParticipants: state.mpParticipants.map((p) =>
        p.id === participantId ? { ...p, persona } : p,
      ),
    })),

  setParticipantTyping: (participantId, typing) =>
    set((state) => ({
      mpParticipants: state.mpParticipants.map((p) =>
        p.id === participantId ? { ...p, typing } : p,
      ),
    })),

  setRoomTurn: (turn) =>
    set((state) => ({
      mpCurrentTurnParticipantId: turn.currentTurnParticipantId,
      mpTurnOrder: turn.turnOrder ?? state.mpTurnOrder,
      mpRound: turn.round ?? state.mpRound,
      mpFreeformDeadline:
        turn.freeformDeadline !== undefined ? turn.freeformDeadline : state.mpFreeformDeadline,
      mpParticipants: withTurnFlags(state.mpParticipants, turn.currentTurnParticipantId),
    })),

  isMyTurn: () => {
    const s = get()
    if (!s.mpRoomId) return true // not in a room → never gate
    if (s.mpTurnStrategy === 'freeform') {
      return s.mpFreeformDeadline != null && Date.now() / 1000 < s.mpFreeformDeadline
    }
    return s.mpCurrentTurnParticipantId === s.mpMyParticipantId
  },
})
