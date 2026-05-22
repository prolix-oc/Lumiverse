import type { StateCreator } from 'zustand'
import type { MigrationSlice } from '@/types/store'
import type { MigrationProgressPayload, MigrationLogPayload, MigrationCompletedPayload, MigrationFailedPayload } from '@/types/ws-events'

const MAX_MIGRATION_LOGS = 400

export const createMigrationSlice: StateCreator<MigrationSlice> = (set) => ({
  migrationId: null,
  migrationPhase: null,
  migrationProgress: null,
  migrationLogs: [],
  migrationResult: null,
  migrationError: null,

  setMigrationStarted: (id: string) => {
    set({
      migrationId: id,
      migrationPhase: 'starting',
      migrationProgress: null,
      migrationLogs: [],
      migrationResult: null,
      migrationError: null,
    })
  },

  setMigrationProgress: (payload: MigrationProgressPayload) => {
    set((state) => {
      const current = state.migrationProgress
      if (
        state.migrationPhase === payload.phase
        && current?.current === payload.current
        && current?.total === payload.total
        && current?.label === payload.label
      ) {
        return state
      }

      return {
        migrationPhase: payload.phase,
        migrationProgress: { current: payload.current, total: payload.total, label: payload.label },
      }
    })
  },

  addMigrationLog: (payload: MigrationLogPayload) => {
    set((state) => ({
      migrationLogs: [...state.migrationLogs, { level: payload.level, message: payload.message, timestamp: Date.now() }].slice(-MAX_MIGRATION_LOGS),
    }))
  },

  replaceMigrationLogs: (logs) => {
    set((state) => {
      if (logs.length === 0 || logs.length < state.migrationLogs.length) {
        return state
      }
      return { migrationLogs: logs.slice(-MAX_MIGRATION_LOGS) }
    })
  },

  setMigrationCompleted: (payload: MigrationCompletedPayload) => {
    set({
      migrationPhase: 'completed',
      migrationProgress: null,
      migrationResult: payload,
    })
  },

  setMigrationFailed: (payload: MigrationFailedPayload) => {
    set({
      migrationPhase: 'failed',
      migrationProgress: null,
      migrationError: payload.error,
    })
  },

  resetMigration: () => {
    set({
      migrationId: null,
      migrationPhase: null,
      migrationProgress: null,
      migrationLogs: [],
      migrationResult: null,
      migrationError: null,
    })
  },
})
