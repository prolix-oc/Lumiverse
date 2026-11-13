import type { StateCreator } from 'zustand'
import type { ChatHeadsSlice, ChatHeadEntry } from '@/types/store'
import { generateApi } from '@/api/generate'

// ── localStorage persistence ──

const HEADS_KEY = 'lumiverse:chatHeads'
const CLEARED_KEY = 'lumiverse:chatHeadsAttentionCleared'
const POS_KEY = 'lumiverse:chatHeadsPos'

export function clearChatHeadsPersistence() {
  try {
    localStorage.removeItem(HEADS_KEY)
    localStorage.removeItem(CLEARED_KEY)
  } catch {}
}

function loadHeads(): ChatHeadEntry[] {
  try {
    const raw = localStorage.getItem(HEADS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

function saveHeads(heads: ChatHeadEntry[]) {
  try { localStorage.setItem(HEADS_KEY, JSON.stringify(heads)) } catch {}
}

function loadClearedAttention(): Set<string> {
  try {
    const raw = localStorage.getItem(CLEARED_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [])
  } catch { return new Set() }
}

function saveClearedAttention(keys: Set<string>) {
  try { localStorage.setItem(CLEARED_KEY, JSON.stringify([...keys])) } catch {}
}

function attentionKey(chatId: string, generationId: string): string {
  return `${chatId}:${generationId}`
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
      const existing = idx >= 0 ? state.chatHeads[idx] : undefined
      const cleared = existing?.generationId === head.generationId ? existing.attentionCleared : false
      const nextHead = { ...head, attentionCleared: cleared }
      let next
      if (idx >= 0) {
        next = [...state.chatHeads]
        next[idx] = nextHead
      } else {
        next = [...state.chatHeads, nextHead]
      }
      saveHeads(next)
      return { chatHeads: next }
    }),

  updateChatHead: (generationId, updates) =>
    set((state) => {
      const next = state.chatHeads.map((h) =>
        h.generationId === generationId ? { ...h, ...updates } : h
      )
      // Persist terminal/attention transitions, not high-frequency streaming changes.
      if (updates.status === 'completed' || updates.status === 'stopped' || updates.status === 'error' || updates.attentionCleared != null) {
        saveHeads(next)
      }
      return { chatHeads: next }
    }),

  deleteChatHead: (chatId) =>
    set((state) => {
      const next = state.chatHeads.filter((h) => h.chatId !== chatId)
      saveHeads(next)
      return { chatHeads: next }
    }),

  removeChatHead: (chatId) => {
    set((state) => {
      const clearedKeys = loadClearedAttention()
      const next = state.chatHeads.map((h) => {
        if (h.chatId !== chatId) return h
        clearedKeys.add(attentionKey(h.chatId, h.generationId))
        return { ...h, attentionCleared: true }
      })
      saveClearedAttention(clearedKeys)
      saveHeads(next)
      return { chatHeads: next }
    })
  },

  setChatHeadsPosition: (pos) => {
    savePos(pos)
    set({ chatHeadsPosition: pos })
  },

  reconcileChatHeads: async () => {
    try {
      const entries = await generateApi.getActive()
      const heads = get().chatHeads
      const clearedKeys = loadClearedAttention()
      const next: ChatHeadEntry[] = []

      // Backend entries are authoritative for status. Local state only tracks
      // whether this client already cleared the terminal attention pip.
      for (const entry of entries) {
        const existing = heads.find((h) => h.chatId === entry.chatId && h.generationId === entry.generationId)
        const head: ChatHeadEntry = {
          generationId: entry.generationId,
          chatId: entry.chatId,
          characterName: entry.characterName || 'Assistant',
          characterId: entry.characterId,
          avatarUrl: null,
          status: entry.councilRetryPending ? 'council_failed' : entry.status as ChatHeadEntry['status'],
          model: entry.model || '',
          startedAt: entry.startedAt || Date.now(),
          attentionCleared: existing?.attentionCleared || clearedKeys.has(attentionKey(entry.chatId, entry.generationId)),
        }
        next.push(head)
      }

      saveHeads(next)
      set({ chatHeads: next })
    } catch {
      // Backend unreachable — keep persisted heads as-is
    }
  },
})
