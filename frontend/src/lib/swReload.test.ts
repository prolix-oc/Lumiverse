import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import { installServiceWorkerReload } from './swReload'
import { SERVICE_WORKER_RELOAD_GUARD_KEY } from './swUpdatePolicy'

afterEach(() => { mock.restore() })

function fixture(controlled = true) {
  const workers = Object.assign(new EventTarget(), { controller: controlled ? {} : null })
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const reload = mock(() => {})
  const check = installServiceWorkerReload(workers as ServiceWorkerContainer, () => storage, reload)
  const takeControl = () => { workers.controller = {}; workers.dispatchEvent(new Event('controllerchange')) }
  return { workers, values, reload, check, takeControl }
}

test('waits for the new controller when the plugin callback arrives early', () => {
  const { check, reload, takeControl } = fixture()
  check() // activated, but clients.claim has not changed this document yet
  expect(reload).not.toHaveBeenCalled()
  takeControl()
  expect(reload).toHaveBeenCalledTimes(1)
  check()
  takeControl()
  expect(reload).toHaveBeenCalledTimes(1)
})

test('handles an external tab update without a plugin callback', () => {
  const { reload, takeControl } = fixture()
  takeControl()
  expect(reload).toHaveBeenCalledTimes(1)
})

test('does not reload on first install but observes the next replacement', () => {
  const { reload, takeControl } = fixture(false)
  takeControl()
  expect(reload).not.toHaveBeenCalled()
  takeControl()
  expect(reload).toHaveBeenCalledTimes(1)
})

test('retries a guarded real update instead of leaving stale JS indefinitely', () => {
  const { values, takeControl, reload } = fixture()
  values.set(SERVICE_WORKER_RELOAD_GUARD_KEY, String(Date.now()))
  let retry: () => void
  spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { retry = callback; return 1 }) as typeof setTimeout)
  takeControl()
  expect(reload).not.toHaveBeenCalled()
  values.delete(SERVICE_WORKER_RELOAD_GUARD_KEY)
  retry!()
  expect(reload).toHaveBeenCalledTimes(1)
})
