import { beforeEach, expect, mock, test } from 'bun:test'
import { invalidateSharedReads } from '@/lib/shared-read'

const requests: Array<(value: unknown) => void> = []
mock.module('./client', () => ({ get: () => new Promise(resolve => requests.push(resolve)) }))
const { bootstrapApi } = await import('./bootstrap')
beforeEach(() => { invalidateSharedReads(); requests.length = 0 })
const response = { payload: { startupSettings: {}, recentChats: { data: [], total: 0, limit: 24, offset: 0 } }, errors: {} }

test('landing readers join the pending bootstrap and release it after completion', async () => {
  const a = bootstrapApi.fetchLanding(); const b = bootstrapApi.fetchLanding()
  expect(bootstrapApi.pendingLanding()).not.toBeNull()
  await Promise.resolve()
  expect(requests).toHaveLength(1)
  requests[0](response)
  await Promise.all([a, b])
  expect(bootstrapApi.pendingLanding()).toBeNull()
})

test('a mutation, reconnect or account reset invalidates pending landing data', async () => {
  const old = bootstrapApi.fetchLanding().catch(error => error)
  await Promise.resolve()
  invalidateSharedReads()
  expect(bootstrapApi.pendingLanding()).toBeNull()
  const fresh = bootstrapApi.fetchLanding()
  await Promise.resolve()
  requests[0](response)
  expect(await old).toBeInstanceOf(Error)
  // Settling the old request cannot clear the fresh flight.
  expect(bootstrapApi.pendingLanding()).not.toBeNull()
  requests[1](response)
  expect(await fresh).toEqual(response)
})
