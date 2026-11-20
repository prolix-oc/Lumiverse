import type { StateCreator } from 'zustand'
import type { AppStore, OperatorSlice } from '@/types/store'
import type { ImageThumbnailQueuePayload, OperatorLogEntry, OperatorStatusPayload } from '@/types/ws-events'

const DEFAULT_LOG_LIMIT = 150
const MAX_LOG_LIMIT = 2000

export const EMPTY_THUMBNAIL_QUEUE: ImageThumbnailQueuePayload = {
  processed: 0,
  remaining: 0,
  total: 0,
  active: 0,
  queued: 0,
}

export const createOperatorSlice: StateCreator<AppStore, [], [], OperatorSlice> = (set) => ({
  operatorLogs: [],
  operatorStatus: null,
  operatorBusy: null,
  operatorProgressMessage: null,
  thumbnailQueue: EMPTY_THUMBNAIL_QUEUE,

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

  setOperatorProgressMessage: (message: string | null) =>
    set({ operatorProgressMessage: message }),

  setThumbnailQueue: (status: ImageThumbnailQueuePayload) =>
    set({ thumbnailQueue: status }),

  clearOperatorLogs: () =>
    set({ operatorLogs: [] }),
})
