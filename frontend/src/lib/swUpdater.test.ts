import { afterAll, expect, mock, test } from 'bun:test'

const setPending = mock((_value: boolean) => {})
mock.module('@/store', () => ({ useStore: { getState: () => ({ setWsUpdatePending: setPending }) } }))
const { checkForBundleUpdate, rememberRegistration } = await import('./swUpdater')
afterAll(() => { mock.restore() })

test('keeps a reconnect check that arrived before registration, and coalesces concurrent checks', async () => {
  await checkForBundleUpdate()
  let finish: () => void
  const update = mock(() => new Promise<void>(resolve => { finish = resolve }))
  const reg = Object.assign(new EventTarget(), { active: {}, installing: null, update })
  rememberRegistration(reg as unknown as ServiceWorkerRegistration)
  expect(update).toHaveBeenCalledTimes(1)
  const pending = checkForBundleUpdate()
  const another = checkForBundleUpdate()
  expect(pending).toBe(another)
  expect(update).toHaveBeenCalledTimes(1)
  finish!()
  await pending
})

test('observes a replacement already installing when registration resolves', () => {
  const installing = Object.assign(new EventTarget(), { state: 'installing' })
  const reg = Object.assign(new EventTarget(), { active: {}, installing, update: async () => {} })
  rememberRegistration(reg as unknown as ServiceWorkerRegistration)
  expect(setPending).toHaveBeenLastCalledWith(true)
  installing.state = 'activated'
  installing.dispatchEvent(new Event('statechange'))
  expect(setPending).toHaveBeenLastCalledWith(false)
})

test('handles a failed network check and permits a later retry', async () => {
  const update = mock(async () => { throw new Error('offline') })
  const reg = Object.assign(new EventTarget(), { active: {}, installing: null, update })
  rememberRegistration(reg as unknown as ServiceWorkerRegistration)
  await checkForBundleUpdate()
  await checkForBundleUpdate()
  expect(update).toHaveBeenCalledTimes(2)
})
