import type { StateCreator } from 'zustand'
import type { AuthSlice, AuthUser } from '@/types/store'
import { authClient, getAuthErrorMessage, readAuthErrorResponseMeta, type AuthErrorResponseMeta } from '@/api/auth'
import { post, get, del } from '@/api/client'
import { resetUserScopedStoreState } from '../user-scoped-reset'
import { setSettingsPersistenceScope } from './settings'
import { setPresetSaveCoordinatorScope } from '@/lib/loom/preset-save-coordinator'

let authMutationGeneration = 0
let sessionCheckGeneration = 0
let pendingLoginGeneration: number | null = null

export const createAuthSlice: StateCreator<AuthSlice> = (set, getState) => ({
  user: null,
  session: null,
  isAuthenticated: false,
  isAuthLoading: true,
  authError: null,

  login: async (username: string, password: string) => {
    const mutationGeneration = ++authMutationGeneration
    sessionCheckGeneration += 1
    pendingLoginGeneration = mutationGeneration
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
      if (mutationGeneration !== authMutationGeneration) return

      if (error) {
        const message = getAuthErrorMessage(error, 'login', responseMeta)
        set({ authError: message })
        throw new Error(message)
      }

      if (data?.user) {
        resetUserScopedStoreState()
        setSettingsPersistenceScope(data.user.id)
        setPresetSaveCoordinatorScope(data.user.id)
        set({
          user: data.user as AuthUser,
          session: { token: data.token } as any,
          isAuthenticated: true,
          isAuthLoading: false,
          authError: null,
        })
      }
    } catch (error) {
      if (mutationGeneration !== authMutationGeneration) return
      const message = getAuthErrorMessage(error, 'login', responseMeta)
      set({ authError: message, isAuthLoading: false })
      throw new Error(message)
    } finally {
      if (pendingLoginGeneration === mutationGeneration) {
        pendingLoginGeneration = null
      }
    }
  },

  logout: async () => {
    authMutationGeneration += 1
    sessionCheckGeneration += 1
    pendingLoginGeneration = null
    resetUserScopedStoreState()
    set({
      user: null,
      session: null,
      isAuthenticated: false,
      isAuthLoading: false,
      authError: null,
    })
    await authClient.signOut()
  },

  checkSession: async () => {
    const mutationGeneration = authMutationGeneration
    const requestGeneration = ++sessionCheckGeneration
    const startedDuringLogin = pendingLoginGeneration !== null
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
      if (
        startedDuringLogin
        || mutationGeneration !== authMutationGeneration
        || requestGeneration !== sessionCheckGeneration
      ) return

      if (data?.user) {
        const currentUserId = getState().user?.id
        if (currentUserId && currentUserId !== data.user.id) {
          resetUserScopedStoreState()
        }
        setSettingsPersistenceScope(data.user.id)
        setPresetSaveCoordinatorScope(data.user.id)
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
      if (
        startedDuringLogin
        || mutationGeneration !== authMutationGeneration
        || requestGeneration !== sessionCheckGeneration
      ) return
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
