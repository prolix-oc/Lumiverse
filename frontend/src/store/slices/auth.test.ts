/// <reference types="bun-types" />

import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { AuthSlice } from '@/types/store'
import { resetSettingsPersistence } from './settings'
const authClientMock: any = {
  signIn: {
    username: async () => ({ data: null, error: null }),
  },
  signOut: async () => {},
  getSession: async () => ({ data: null }),
}

mock.module('@/api/auth', () => ({
  authClient: authClientMock,
  getAuthErrorMessage: (error: unknown) => error instanceof Error ? error.message : 'Authentication failed',
  readAuthErrorResponseMeta: async () => null,
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

let createAuthSlice: typeof import('./auth').createAuthSlice

beforeAll(async () => {
  ;({ createAuthSlice } = await import('./auth'))
})

function createStore(): AuthSlice {
  const state = {} as AuthSlice
  const set = (partial: Partial<AuthSlice> | ((current: AuthSlice) => Partial<AuthSlice>)) => {
    Object.assign(state, typeof partial === 'function' ? partial(state) : partial)
  }
  const get = () => state
  Object.assign(state, createAuthSlice(set as never, get as never, {} as never))
  return state
}

afterEach(() => {
  resetSettingsPersistence()
  authClientMock.getSession = async () => ({ data: null })
  authClientMock.signIn.username = async () => ({ data: null, error: null })
  authClientMock.signOut = async () => {}
})

describe('auth request ordering', () => {
  test('ignores an earlier unauthenticated session response after login succeeds', async () => {
    const store = createStore()
    const staleSession = createDeferred<{ data: null }>()
    authClientMock.getSession = () => staleSession.promise
    authClientMock.signIn.username = async () => ({
      data: {
        user: { id: 'user-b', name: 'User B', role: 'user' },
        token: 'user-b-token',
      },
      error: null,
    })

    const checking = store.checkSession()
    await Promise.resolve()
    await store.login('user-b', 'password')

    expect(store.isAuthenticated).toBe(true)
    expect(store.user?.id).toBe('user-b')

    staleSession.resolve({ data: null })
    await checking

    expect(store.isAuthenticated).toBe(true)
    expect(store.user?.id).toBe('user-b')
    expect(store.authError).toBeNull()
  })

  test('does not let a session check started during login override that login', async () => {
    const store = createStore()
    const pendingLogin = createDeferred<{
      data: { user: { id: string; name: string; role: string }; token: string }
      error: null
    }>()
    authClientMock.signIn.username = () => pendingLogin.promise
    authClientMock.getSession = async () => ({ data: null })

    const loggingIn = store.login('user-b', 'password')
    await Promise.resolve()
    await store.checkSession()

    pendingLogin.resolve({
      data: {
        user: { id: 'user-b', name: 'User B', role: 'user' },
        token: 'user-b-token',
      },
      error: null,
    })
    await loggingIn

    expect(store.isAuthenticated).toBe(true)
    expect(store.user?.id).toBe('user-b')
  })

  test('settles loading when a login fails after suppressing its concurrent session check', async () => {
    const store = createStore()
    const pendingLogin = createDeferred<{ data: null; error: { message: string } }>()
    authClientMock.signIn.username = () => pendingLogin.promise
    authClientMock.getSession = async () => ({ data: null })

    const loggingIn = store.login('user-b', 'bad-password')
    await Promise.resolve()
    await store.checkSession()

    pendingLogin.resolve({ data: null, error: { message: 'Invalid credentials' } })
    await expect(loggingIn).rejects.toThrow('Authentication failed')

    expect(store.isAuthLoading).toBe(false)
    expect(store.authError).toBe('Authentication failed')
  })
})
