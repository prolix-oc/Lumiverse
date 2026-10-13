import { describe, expect, test } from 'bun:test'
import { createSystemAudioConsentStore } from './system-audio-consent'

function rig() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  const open = () => createSystemAudioConsentStore(() => storage)
  return { values, storage, open, store: open() }
}

describe('remembered system audio consent', () => {
  test('asks by default and retains an explicit approval across reloads', () => {
    const t = rig()
    expect(t.store.read('alice', 'installed-a')).toEqual({ remembered: false, paused: false })
    expect(t.store.remember('alice', 'installed-a')).toBe(true)
    expect(t.open().read('alice', 'installed-a')).toEqual({ remembered: true, paused: false })
  })

  test('does not transfer approval between accounts, installs, or devices', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    expect(t.store.read('bob', 'installed-a').remembered).toBe(false)
    expect(t.store.read('alice', 'reinstalled-a').remembered).toBe(false)
    expect(rig().store.read('alice', 'installed-a').remembered).toBe(false)
    expect(t.store.remember(null, 'installed-a')).toBe(false)
  })

  test('Stop remains paused across reloads, until an explicit resume preserves the grant', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    t.store.pause('alice', 'installed-a')
    const reloaded = t.open()
    expect(reloaded.read('alice', 'installed-a')).toEqual({ remembered: true, paused: true })
    reloaded.resume('alice', 'installed-a')
    expect(t.open().read('alice', 'installed-a')).toEqual({ remembered: true, paused: false })
  })

  test('revocation forgets approval and blocks starts until the user permits requests again', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    t.store.revoke('alice', 'installed-a')
    expect(t.open().read('alice', 'installed-a')).toEqual({ remembered: false, paused: true })
    t.store.resume('alice', 'installed-a')
    expect(t.open().read('alice', 'installed-a')).toEqual({ remembered: false, paused: false })
    expect(t.values.size).toBe(0)
  })

  test('permission revocation or uninstall clears both approval and pause state', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    t.store.pause('alice', 'installed-a')
    t.store.clear('alice', 'installed-a')
    expect(t.open().read('alice', 'installed-a')).toEqual({ remembered: false, paused: false })
    expect(t.values.size).toBe(0)
  })

  test('permission events clear an unloaded extension approval without affecting another account or permission', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    t.store.remember('bob', 'installed-a')
    t.store.permissionsChanged('alice', { extensionId: 'installed-a', allGranted: ['system_audio'] })
    t.store.permissionsChanged('alice', { extensionId: 'installed-a', allGranted: 'invalid' })
    expect(t.open().read('alice', 'installed-a').remembered).toBe(true)
    t.store.permissionsChanged('alice', { extensionId: 'installed-a', allGranted: [] })
    expect(t.open().read('alice', 'installed-a').remembered).toBe(false)
    expect(t.open().read('bob', 'installed-a').remembered).toBe(true)
  })

  test('malformed or unavailable storage cannot grant approval, while Stop still takes effect', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    for (const raw of ['{', 'true', '{"remembered":"true","paused":false}']) {
      t.values.set([...t.values.keys()][0], raw)
      expect(t.open().read('alice', 'installed-a').remembered).toBe(false)
    }
    const blocked = createSystemAudioConsentStore(() => { throw new Error('Storage denied') })
    expect(blocked.remember('alice', 'installed-a')).toBe(false)
    blocked.pause('alice', 'installed-a')
    expect(blocked.read('alice', 'installed-a')).toEqual({ remembered: false, paused: true })
  })

  test('cross-window changes notify the matching account and stop notifying after unsubscribe', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    const changes: unknown[] = []
    const unsubscribe = t.store.subscribe('alice', 'installed-a', (next, change) => changes.push([next, change]))
    const other = t.open()
    other.revoke('alice', 'installed-a')
    t.store.refresh([...t.values.keys()][0])
    expect(changes).toEqual([[{ remembered: false, paused: true }, 'external']])
    unsubscribe()
    other.clear('alice', 'installed-a')
    t.store.refresh(null)
    expect(changes).toHaveLength(1)
    expect(t.store.read('alice', 'installed-a')).toEqual({ remembered: false, paused: false })
  })

  test('a quota failure while stopping removes the old saved grant and keeps this session paused', () => {
    const t = rig()
    t.store.remember('alice', 'installed-a')
    t.storage.setItem = () => { throw new Error('Quota exceeded') }
    t.store.pause('alice', 'installed-a')
    expect(t.store.read('alice', 'installed-a').paused).toBe(true)
    expect(t.open().read('alice', 'installed-a').remembered).toBe(false)
  })
})
