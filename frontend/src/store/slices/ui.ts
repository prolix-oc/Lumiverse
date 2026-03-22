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
  settingsActiveView: 'general',
  portraitPanelOpen: false,
  commandPaletteOpen: false,
  toasts: [],

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

  openSettings: (view = 'general') =>
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
})
