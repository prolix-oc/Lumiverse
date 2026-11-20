import { expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { ActiveTab, InactiveTabError } from './active-tab'

function fixture() {
  const first = new JSDOM('', { url: 'http://localhost/' }).window
  const second = new JSDOM('', { url: 'http://localhost/' }).window
  const storage = first.localStorage
  Object.defineProperty(second, 'localStorage', { value: storage })
  const notify = (target: typeof first, key = 'lumiverse:active-tab:account') => {
    target.dispatchEvent(new target.StorageEvent('storage', { key, storageArea: storage }))
  }
  return { first, second, storage, notify }
}

test('a new document blocks the previous owner and only an explicit new document can reclaim', () => {
  const { first, second, notify } = fixture()
  const oldTab = new ActiveTab('old', first as unknown as Window)
  const newTab = new ActiveTab('new', second as unknown as Window)
  const releaseOld = oldTab.claim('account')
  const releaseNew = newTab.claim('account')
  notify(first)
  expect(oldTab.signal.aborted).toBe(true)
  expect(() => oldTab.claim('account')).toThrow(InactiveTabError)
  expect(newTab.signal.aborted).toBe(false)
  releaseNew()
  first.dispatchEvent(new first.Event('focus'))
  expect(oldTab.signal.aborted).toBe(true)
  const reloaded = new ActiveTab('reloaded', first as unknown as Window)
  const releaseReloaded = reloaded.claim('account')
  expect(reloaded.signal.aborted).toBe(false)
  releaseOld(); releaseReloaded()
  first.close(); second.close()
})

test('delayed notifications preserve the latest claim when documents open together', () => {
  const { first, second, notify } = fixture()
  const a = new ActiveTab('a', first as unknown as Window)
  const b = new ActiveTab('b', second as unknown as Window)
  const releaseA = a.claim('account')
  const releaseB = b.claim('account')
  notify(second)
  notify(first)
  expect(a.signal.aborted).toBe(true)
  expect(b.signal.aborted).toBe(false)
  releaseA(); releaseB(); first.close(); second.close()
})

test('different accounts do not displace each other', () => {
  const { first, second, notify } = fixture()
  const a = new ActiveTab('a', first as unknown as Window)
  const b = new ActiveTab('b', second as unknown as Window)
  const releaseA = a.claim('account')
  const releaseB = b.claim('another-account')
  notify(first, 'lumiverse:active-tab:another-account')
  expect(a.signal.aborted).toBe(false)
  expect(b.signal.aborted).toBe(false)
  releaseA(); releaseB(); first.close(); second.close()
})

test('a suspended document checks ownership before foreground recovery', () => {
  for (const event of ['pageshow', 'focus']) {
    const { first, second, storage } = fixture()
    const a = new ActiveTab('a', first as unknown as Window)
    const release = a.claim('account')
    storage.setItem('lumiverse:active-tab:account', 'replacement')
    first.dispatchEvent(new first.Event(event))
    expect(a.signal.aborted).toBe(true)
    release(); first.close(); second.close()
  }
})

test('clearing ownership blocks the document instead of silently reclaiming', () => {
  const { first, second, storage, notify } = fixture()
  const tab = new ActiveTab('a', first as unknown as Window)
  const release = tab.claim('account')
  storage.clear()
  notify(first, null as unknown as string)
  expect(() => tab.assertActive()).toThrow(InactiveTabError)
  release(); first.close(); second.close()
})

test('changing account releases the old ownership listeners', () => {
  const { first, second, storage, notify } = fixture()
  const tab = new ActiveTab('document', first as unknown as Window)
  tab.claim('account')()
  const release = tab.claim('new-account')
  storage.setItem('lumiverse:active-tab:account', 'replacement')
  notify(first)
  expect(tab.signal.aborted).toBe(false)
  release(); first.close(); second.close()
})

test('visibility recovery checks the current owner even without a storage notification', () => {
  const { first, second, storage } = fixture()
  const tab = new ActiveTab('document', first as unknown as Window)
  const release = tab.claim('account')
  storage.setItem('lumiverse:active-tab:account', 'replacement')
  Object.defineProperty(first.document, 'visibilityState', { value: 'visible' })
  first.document.dispatchEvent(new first.Event('visibilitychange'))
  expect(() => tab.assertActive()).toThrow(InactiveTabError)
  release(); first.close(); second.close()
})

test('unavailable browser storage fails the claim explicitly', () => {
  const { first, second } = fixture()
  const error = new Error('Browser storage unavailable')
  Object.defineProperty(first, 'localStorage', { get() { throw error } })
  const tab = new ActiveTab('document', first as unknown as Window)
  expect(() => tab.claim('account')).toThrow(error)
  first.close(); second.close()
})


test('opting out persists per account and allows two tabs until protection is reenabled', () => {
  const { first, second, notify } = fixture()
  const a = new ActiveTab('a', first as unknown as Window)
  const b = new ActiveTab('b', second as unknown as Window)
  expect(a.isEnforced('account')).toBe(true)
  const releaseA = a.claim('account')
  a.setEnforced('account', false)
  expect(b.isEnforced('account')).toBe(false)
  expect(b.isEnforced('other-account')).toBe(true)
  const releaseB = b.claim('account')
  notify(first)
  first.dispatchEvent(new first.Event('focus'))
  expect(a.signal.aborted).toBe(false)
  expect(b.signal.aborted).toBe(false)
  a.setEnforced('account', true)
  notify(second, 'lumiverse:allow-multiple-tabs:account')
  notify(first)
  expect(a.signal.aborted).toBe(false)
  expect(b.signal.aborted).toBe(true)
  expect(() => b.setEnforced('account', false)).toThrow(InactiveTabError)
  releaseA(); releaseB(); first.close(); second.close()
})

test('opting out does not revive a document whose work was already cancelled', () => {
  const { first, second, notify } = fixture()
  const a = new ActiveTab('a', first as unknown as Window)
  const b = new ActiveTab('b', second as unknown as Window)
  const releaseA = a.claim('account')
  const releaseB = b.claim('account')
  notify(first)
  b.setEnforced('account', false)
  notify(first, 'lumiverse:allow-multiple-tabs:account')
  expect(a.signal.aborted).toBe(true)
  const reloaded = new ActiveTab('reloaded', first as unknown as Window)
  const releaseReloaded = reloaded.claim('account')
  notify(second)
  expect(reloaded.signal.aborted).toBe(false)
  expect(b.signal.aborted).toBe(false)
  releaseA(); releaseB(); releaseReloaded(); first.close(); second.close()
})
