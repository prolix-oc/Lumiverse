import type { StateCreator } from 'zustand'
import type { AppStore, OperatorSlice } from '@/types/store'
import type { OperatorLogEntry, OperatorStatusPayload } from '@/types/ws-events'

const DEFAULT_LOG_LIMIT = 150
const MAX_LOG_LIMIT = 2000

export const createOperatorSlice: StateCreator<AppStore, [], [], OperatorSlice> = (set) => ({
  operatorLogs: [],
  operatorStatus: null,
  operatorBusy: null,

  appendOperatorLogs: (entries: OperatorLogEntry[]) =>
    set((state) => {
      const bufferSize = parseInt(
        localStorage.getItem('operator_log_buffer_size') || String(DEFAULT_LOG_LIMIT),
        10
      ) || DEFAULT_LOG_LIMIT
      const limit = Math.min(MAX_LOG_LIMIT, Math.max(50, bufferSize))
      const combined = [...state.operatorLogs, ...entries]
      return {
        operatorLogs: combined.length > limit ? combined.slice(-limit) : combined,
      }
    }),

  setOperatorStatus: (status: OperatorStatusPayload) =>
    set({ operatorStatus: status }),

  setOperatorBusy: (operation: string | null) =>
    set({ operatorBusy: operation }),

  clearOperatorLogs: () =>
    set({ operatorLogs: [] }),
})
