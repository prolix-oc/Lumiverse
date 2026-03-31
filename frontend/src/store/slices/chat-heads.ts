import type { StateCreator } from 'zustand'
import type { ChatHeadsSlice, ChatHeadEntry } from '@/types/store'
import { generateApi } from '@/api/generate'

export const createChatHeadsSlice: StateCreator<ChatHeadsSlice> = (set, get) => ({
  chatHeads: [],
  chatHeadsPosition: { xPct: -1, yPct: -1 },

  addChatHead: (head: ChatHeadEntry) =>
    set((state) => {
      const idx = state.chatHeads.findIndex((h) => h.chatId === head.chatId)
      if (idx >= 0) {
        const next = [...state.chatHeads]
        next[idx] = head
        return { chatHeads: next }
      }
      return { chatHeads: [...state.chatHeads, head] }
    }),

  updateChatHead: (generationId, updates) =>
    set((state) => ({
      chatHeads: state.chatHeads.map((h) =>
        h.generationId === generationId ? { ...h, ...updates } : h
      ),
    })),

  removeChatHead: (chatId) => {
    set((state) => ({
      chatHeads: state.chatHeads.filter((h) => h.chatId !== chatId),
    }))
    // Tell the backend this chat's generation has been acknowledged
    generateApi.acknowledge(chatId).catch(() => {})
  },

  setChatHeadsPosition: (pos) => set({ chatHeadsPosition: pos }),

  reconcileChatHeads: async () => {
    try {
      const entries = await generateApi.getActive()
      if (entries.length === 0) return
      const heads = get().chatHeads
      const next = [...heads]
      for (const entry of entries) {
        const existing = next.findIndex((h) => h.chatId === entry.chatId)
        const head: ChatHeadEntry = {
          generationId: entry.generationId,
          chatId: entry.chatId,
          characterName: entry.characterName || 'Assistant',
          characterId: entry.characterId,
          avatarUrl: null,
          status: entry.councilRetryPending ? 'council_failed' : entry.status as ChatHeadEntry['status'],
          model: entry.model || '',
          startedAt: entry.startedAt || Date.now(),
        }
        if (existing >= 0) {
          next[existing] = head
        } else {
          next.push(head)
        }
      }
      set({ chatHeads: next })
    } catch {
      // Backend unreachable — nothing to reconcile
    }
  },
})
