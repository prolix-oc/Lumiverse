import type { StateCreator } from 'zustand'
import type { McpServersSlice } from '@/types/store'

export const createMcpServersSlice: StateCreator<McpServersSlice> = (set) => ({
  mcpServers: [],
  mcpServerStatuses: {},

  setMcpServers: (servers) => set({ mcpServers: servers }),

  addMcpServer: (server) =>
    set((state) => ({ mcpServers: [...state.mcpServers, server] })),

  updateMcpServer: (id, updates) =>
    set((state) => ({
      mcpServers: state.mcpServers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    })),

  removeMcpServer: (id) =>
    set((state) => ({
      mcpServers: state.mcpServers.filter((s) => s.id !== id),
      mcpServerStatuses: Object.fromEntries(
        Object.entries(state.mcpServerStatuses).filter(([k]) => k !== id)
      ),
    })),

  setMcpServerStatus: (id, status) =>
    set((state) => ({
      mcpServerStatuses: { ...state.mcpServerStatuses, [id]: status },
    })),
})
