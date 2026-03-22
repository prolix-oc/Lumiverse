import type { StateCreator } from 'zustand'
import type { AuthSlice, AuthUser } from '@/types/store'
import { authClient } from '@/api/auth'
import { post, get, del } from '@/api/client'

export const createAuthSlice: StateCreator<AuthSlice> = (set) => ({
  user: null,
  session: null,
  isAuthenticated: false,
  isAuthLoading: true,

  login: async (username: string, password: string) => {
    const { data, error } = await authClient.signIn.username({
      username,
      password,
    })

    if (error) {
      throw new Error(error.message || 'Login failed')
    }

    if (data?.user) {
      set({
        user: data.user as AuthUser,
        session: { token: data.token } as any,
        isAuthenticated: true,
        isAuthLoading: false,
      })
    }
  },

  logout: async () => {
    await authClient.signOut()
    set({
      user: null,
      session: null,
      isAuthenticated: false,
      isAuthLoading: false,
    })
  },

  checkSession: async () => {
    set({ isAuthLoading: true })
    try {
      const { data } = await authClient.getSession()
      if (data?.user) {
        set({
          user: data.user as AuthUser,
          session: data.session as any,
          isAuthenticated: true,
          isAuthLoading: false,
        })
      } else {
        set({
          user: null,
          session: null,
          isAuthenticated: false,
          isAuthLoading: false,
        })
      }
    } catch {
      set({
        user: null,
        session: null,
        isAuthenticated: false,
        isAuthLoading: false,
      })
    }
  },

  createUser: async (username: string, password: string, role?: string) => {
    await post('/users', { username, password, role })
  },

  listUsers: async () => {
    return get<AuthUser[]>('/users')
  },

  changePassword: async (currentPassword: string, newPassword: string) => {
    await post('/users/me/password', { currentPassword, newPassword })
  },

  resetUserPassword: async (userId: string, newPassword: string) => {
    await post(`/users/${userId}/reset-password`, { newPassword })
  },

  banUser: async (userId: string) => {
    await post(`/users/${userId}/ban`)
  },

  unbanUser: async (userId: string) => {
    await post(`/users/${userId}/unban`)
  },

  deleteUser: async (userId: string) => {
    await del(`/users/${userId}`)
  },

  reconcileRole: (role: string) => {
    set((state) => {
      if (!state.user) return state
      if (state.user.role === role) return state
      return { user: { ...state.user, role } }
    })
  },
})
