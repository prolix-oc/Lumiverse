import type { StateCreator } from 'zustand'
import type { UISlice } from '@/types/store'

let toastCounter = 0

export const createUISlice: StateCreator<UISlice> = (set) => ({
  activeModal: null,
  modalProps: {},
  isLoading: false,
  error: null,
  drawerOpen: false,
  drawerTab: null,
  settingsModalOpen: false,
  settingsActiveView: 'display',
  portraitPanelOpen: false,
  commandPaletteOpen: false,
  toasts: [],
  badgeCount: 0,

  openModal: (name, props = {}) => set({ activeModal: name, modalProps: props }),
  closeModal: () => set({ activeModal: null, modalProps: {} }),
  setLoading: (loading) => set({ isLoading: loading }),
  setError: (error) => set({ error }),

  openDrawer: (tab) =>
    set((state) => ({
      drawerOpen: true,
      drawerTab: tab ?? state.drawerTab,
    })),
  closeDrawer: () => set({ drawerOpen: false }),
  setDrawerTab: (tab) => set({ drawerTab: tab }),

  openSettings: (view = 'display') =>
    set({ settingsModalOpen: true, settingsActiveView: view }),
  closeSettings: () => set({ settingsModalOpen: false }),

  openCommandPalette: () => set({ commandPaletteOpen: true }),
  closeCommandPalette: () => set({ commandPaletteOpen: false }),

  togglePortraitPanel: () =>
    set((state) => ({ portraitPanelOpen: !state.portraitPanelOpen })),

  addToast: (toast) => {
    const id = `toast-${++toastCounter}-${Date.now()}`
    set((state) => ({
      toasts: [...state.toasts, { ...toast, id, dismissible: toast.dismissible ?? true }],
    }))
    return id
  },

  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  clearToasts: () => set({ toasts: [] }),

  incrementBadgeCount: () => set((state) => ({ badgeCount: state.badgeCount + 1 })),
  resetBadgeCount: () => set({ badgeCount: 0 }),

  lastRegenFeedback: '',
  setLastRegenFeedback: (text) => set({ lastRegenFeedback: text }),

  editingMessageId: null,
  setEditingMessageId: (id) => set({ editingMessageId: id }),
})
