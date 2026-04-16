import type { StateCreator } from 'zustand'
import type { ChatHeadsSlice, ChatHeadEntry } from '@/types/store'
import { generateApi } from '@/api/generate'

// ── localStorage persistence ──

const HEADS_KEY = 'lumiverse:chatHeads'
const POS_KEY = 'lumiverse:chatHeadsPos'

const ACTIVE_STATUSES: Set<ChatHeadEntry['status']> = new Set([
  'assembling', 'council', 'council_failed', 'reasoning', 'streaming',
])

function loadHeads(): ChatHeadEntry[] {
  try {
    const raw = localStorage.getItem(HEADS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveHeads(heads: ChatHeadEntry[]) {
  try { localStorage.setItem(HEADS_KEY, JSON.stringify(heads)) } catch {}
}

function loadPos(): { xPct: number; yPct: number } {
  try {
    const raw = localStorage.getItem(POS_KEY)
    return raw ? JSON.parse(raw) : { xPct: -1, yPct: -1 }
  } catch { return { xPct: -1, yPct: -1 } }
}

function savePos(pos: { xPct: number; yPct: number }) {
  try { localStorage.setItem(POS_KEY, JSON.stringify(pos)) } catch {}
}

// ── Slice ──

export const createChatHeadsSlice: StateCreator<ChatHeadsSlice> = (set, get) => ({
  chatHeads: loadHeads(),
  chatHeadsPosition: loadPos(),

  addChatHead: (head: ChatHeadEntry) =>
    set((state) => {
      const idx = state.chatHeads.findIndex((h) => h.chatId === head.chatId)
      let next
      if (idx >= 0) {
        next = [...state.chatHeads]
        next[idx] = head
      } else {
        next = [...state.chatHeads, head]
      }
      saveHeads(next)
      return { chatHeads: next }
    }),

  updateChatHead: (generationId, updates) =>
    set((state) => {
      const next = state.chatHeads.map((h) =>
        h.generationId === generationId ? { ...h, ...updates } : h
      )
      // Persist only on terminal transitions — not during high-frequency streaming
      if (updates.status === 'completed' || updates.status === 'stopped' || updates.status === 'error') {
        saveHeads(next)
      }
      return { chatHeads: next }
    }),

  removeChatHead: (chatId) => {
    set((state) => {
      const next = state.chatHeads.filter((h) => h.chatId !== chatId)
      saveHeads(next)
      return { chatHeads: next }
    })
    // Tell the backend this chat's generation has been acknowledged
    generateApi.acknowledge(chatId).catch(() => {})
  },

  setChatHeadsPosition: (pos) => {
    savePos(pos)
    set({ chatHeadsPosition: pos })
  },

  reconcileChatHeads: async () => {
    try {
      const entries = await generateApi.getActive()
      const heads = get().chatHeads
      const next = [...heads]

      // Merge backend entries (active + unacknowledged terminal)
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

      // Local heads that were streaming but aren't in the backend anymore
      // (server restarted or generation finished while tab was closed) → mark completed
      const backendChatIds = new Set(entries.map((e) => e.chatId))
      for (let i = 0; i < next.length; i++) {
        if (!backendChatIds.has(next[i].chatId) && ACTIVE_STATUSES.has(next[i].status)) {
          next[i] = { ...next[i], status: 'completed' }
        }
      }

      saveHeads(next)
      set({ chatHeads: next })
    } catch {
      // Backend unreachable — keep persisted heads as-is
    }
  },
})
