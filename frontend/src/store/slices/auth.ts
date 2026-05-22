import type { StateCreator } from 'zustand'
import type { AuthSlice, AuthUser } from '@/types/store'
import { authClient, getAuthErrorMessage, readAuthErrorResponseMeta, type AuthErrorResponseMeta } from '@/api/auth'
import { post, get, del } from '@/api/client'
import { resetUserScopedStoreState } from '../user-scoped-reset'

export const createAuthSlice: StateCreator<AuthSlice> = (set) => ({
  user: null,
  session: null,
  isAuthenticated: false,
  isAuthLoading: true,
  authError: null,

  login: async (username: string, password: string) => {
    set({ authError: null })
    let responseMeta: AuthErrorResponseMeta | null = null

    try {
      const { data, error } = await authClient.signIn.username(
        {
          username,
          password,
        },
        {
          onError: async (ctx) => {
            responseMeta = await readAuthErrorResponseMeta(ctx)
          },
        },
      )

      if (error) {
        const message = getAuthErrorMessage(error, 'login', responseMeta)
        set({ authError: message })
        throw new Error(message)
      }

      if (data?.user) {
        resetUserScopedStoreState()
        set({
          user: data.user as AuthUser,
          session: { token: data.token } as any,
          isAuthenticated: true,
          isAuthLoading: false,
          authError: null,
        })
      }
    } catch (error) {
      const message = getAuthErrorMessage(error, 'login', responseMeta)
      set({ authError: message })
      throw new Error(message)
    }
  },

  logout: async () => {
    await authClient.signOut()
    resetUserScopedStoreState()
    set({
      user: null,
      session: null,
      isAuthenticated: false,
      isAuthLoading: false,
      authError: null,
    })
  },

  checkSession: async () => {
    set({ isAuthLoading: true, authError: null })
    let responseMeta: AuthErrorResponseMeta | null = null
    try {
      const { data } = await authClient.getSession({
        fetchOptions: {
          onError: async (ctx) => {
            responseMeta = await readAuthErrorResponseMeta(ctx)
          },
        },
      })
      if (data?.user) {
        set({
          user: data.user as AuthUser,
          session: data.session as any,
          isAuthenticated: true,
          isAuthLoading: false,
          authError: null,
        })
      } else {
        resetUserScopedStoreState()
        set({
          user: null,
          session: null,
          isAuthenticated: false,
          isAuthLoading: false,
          authError: null,
        })
      }
    } catch (error) {
      resetUserScopedStoreState()
      set({
        user: null,
        session: null,
        isAuthenticated: false,
        isAuthLoading: false,
        authError: getAuthErrorMessage(error, 'session', responseMeta),
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
