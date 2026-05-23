import type { StateCreator } from 'zustand'
import type { ConnectionSlice } from '@/types/store'

export const createConnectionSlice: StateCreator<ConnectionSlice> = (set) => ({
  wsConnected: false,
  wsAuthSynced: false,
  wsRoundTripVerified: false,
  wsHasEverConnected: false,
  wsUpdatePending: false,

  setWsConnected: (connected) =>
    set(() =>
      connected
        ? { wsConnected: true }
        : { wsConnected: false, wsAuthSynced: false, wsRoundTripVerified: false },
    ),
  setWsAuthSynced: (synced) => set({ wsAuthSynced: synced }),
  setWsRoundTripVerified: (verified) =>
    set((state) => {
      if (!verified) return { wsRoundTripVerified: false }
      const healthy = state.wsConnected && state.wsAuthSynced
      return {
        wsRoundTripVerified: true,
        wsHasEverConnected: state.wsHasEverConnected || healthy,
      }
    }),
  setWsUpdatePending: (pending) => set({ wsUpdatePending: pending }),
  resetConnectionState: () =>
    set({
      wsConnected: false,
      wsAuthSynced: false,
      wsRoundTripVerified: false,
      wsHasEverConnected: false,
      wsUpdatePending: false,
    }),
})
