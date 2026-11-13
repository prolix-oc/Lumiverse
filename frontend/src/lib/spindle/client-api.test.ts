import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createFrontendClientAPI } from './client-api'

const globals = globalThis as unknown as Record<string, unknown>
const descriptors = ['window', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
const attributes = new Map<string, string>()
const displayModes = new Set<string>()
let nav: Record<string, unknown>
let host: Record<string, unknown>
const api = createFrontendClientAPI(() => {})
const noBridges = { desktop: false, ios: false, android: false }
const invoke = () => { throw new Error('Discovery must never invoke a native command') }

beforeEach(() => {
  attributes.clear()
  displayModes.clear()
  nav = { userAgent: '', platform: '', maxTouchPoints: 0 }
  host = {
    navigator: nav,
    innerWidth: 320,
    matchMedia: (query: string) => ({ matches: displayModes.has(query) }),
  }
  globals.window = host
  globals.document = { documentElement: {
    hasAttribute: (name: string) => attributes.has(name),
    getAttribute: (name: string) => attributes.get(name) ?? null,
  } }
})

afterEach(() => {
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
})

describe('client identity and bridge discovery', () => {
  test.each([
    ['macos', 'MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0, false],
    ['windows', 'Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, false],
    ['linux', 'Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)', 0, false],
    ['ios', 'iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS)', 5, true],
    ['ios', 'MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5, true],
    ['android', 'Linux armv8l', 'Mozilla/5.0 (Linux; Android 15)', 5, true],
    ['unknown', '', '', 0, false],
  ] as const)('identifies a %s browser without granting a native bridge', (platform, navigatorPlatform, userAgent, maxTouchPoints, isMobile) => {
    Object.assign(nav, { platform: navigatorPlatform, userAgent, maxTouchPoints })
    // Android may have a Linux data-platform attribute set by the frontend.
    attributes.set('data-platform', 'linux')
    expect(api.getInfo()).toEqual({ kind: 'browser', platform, isMobile, bridges: noBridges })
  })

  test('uses available UA client hints without confusing touch or viewport size with a mobile OS', () => {
    nav.userAgentData = { platform: 'Windows', mobile: false }
    nav.maxTouchPoints = 10
    expect(api.getInfo()).toMatchObject({ kind: 'browser', platform: 'windows', isMobile: false })
    nav.userAgentData = { platform: 'Android', mobile: true }
    host.innerWidth = 1400
    expect(api.getInfo()).toMatchObject({ kind: 'browser', platform: 'android', isMobile: true })
  })

  test('iOS home-screen PWAs retain mobile identity without native bridges', () => {
    Object.assign(nav, { platform: 'MacIntel', maxTouchPoints: 5, standalone: true })
    expect(api.getInfo()).toEqual({ kind: 'pwa', platform: 'ios', isMobile: true, bridges: noBridges })
  })

  test.each(['standalone', 'minimal-ui', 'window-controls-overlay'])('recognizes the %s PWA display mode', mode => {
    Object.assign(nav, { platform: 'Linux armv8l', userAgent: 'Android' })
    displayModes.add(`(display-mode: ${mode})`)
    expect(api.getInfo()).toEqual({ kind: 'pwa', platform: 'android', isMobile: true, bridges: noBridges })
  })

  test('desktop-installed PWAs stay distinct from the desktop client', () => {
    nav.platform = 'Win32'
    displayModes.add('(display-mode: window-controls-overlay)')
    expect(api.getInfo()).toEqual({ kind: 'pwa', platform: 'windows', isMobile: false, bridges: noBridges })
  })

  test('a fullscreen browser tab does not acquire PWA or native identity', () => {
    displayModes.add('(display-mode: fullscreen)')
    expect(api.getInfo().kind).toBe('browser')
  })

  test('desktop native identity takes precedence over PWA mode and uses the callable transport', () => {
    host.__TAURI_INTERNALS__ = { invoke }
    attributes.set('data-platform', 'macos')
    attributes.set('data-tauri-desktop', '')
    nav.standalone = true
    expect(api.getInfo()).toEqual({ kind: 'desktop', platform: 'macos', isMobile: false,
      bridges: { ...noBridges, desktop: true } })
  })

  test('a desktop popout can be identified by its Tauri transport before DOM markers exist', () => {
    host.__TAURI_INTERNALS__ = { invoke }
    nav.platform = 'Win32'
    expect(api.getInfo()).toEqual({ kind: 'desktop', platform: 'windows', isMobile: false,
      bridges: { ...noBridges, desktop: true } })
  })

  test('desktop markers alone do not advertise a callable bridge', () => {
    attributes.set('data-tauri-desktop', '')
    expect(api.getInfo()).toMatchObject({ kind: 'desktop', bridges: noBridges })
    host.__TAURI_INTERNALS__ = {}
    expect(api.getInfo().bridges).toEqual(noBridges)
  })

  test('Android apps never expose desktop commands, even with stale desktop or PWA markers', () => {
    host.__LUMIVERSE_MOBILE__ = true
    host.__TAURI_INTERNALS__ = { invoke }
    nav.standalone = true
    attributes.set('data-tauri-desktop', '')
    attributes.set('data-platform', 'macos')
    expect(api.getInfo()).toEqual({ kind: 'mobile', platform: 'android', isMobile: true,
      bridges: { ...noBridges, android: true } })
  })

  test('Android mobile DOM markers work before the native global marker', () => {
    attributes.set('data-tauri-mobile', 'android')
    host.__TAURI_INTERNALS__ = { invoke }
    expect(api.getInfo()).toMatchObject({ kind: 'mobile', platform: 'android', bridges: { ...noBridges, android: true } })
  })

  test('native iOS is recognized without Tauri and before DOM markers are installed', () => {
    host.__LUMIVERSE_MOBILE__ = true
    host.__LUMIVERSE_PLATFORM__ = 'ios'
    host.__LUMIVERSE_IOS_NATIVE__ = { version: 1, request: invoke }
    nav.standalone = true
    expect(api.getInfo()).toEqual({ kind: 'mobile', platform: 'ios', isMobile: true,
      bridges: { ...noBridges, ios: true } })
  })

  test('mobile identity does not imply a supported, callable native bridge', () => {
    attributes.set('data-tauri-mobile', 'ios')
    host.__TAURI_INTERNALS__ = { invoke }
    host.__LUMIVERSE_IOS_NATIVE__ = { version: 2, request: invoke }
    expect(api.getInfo()).toMatchObject({ kind: 'mobile', platform: 'ios', bridges: noBridges })
    host.__LUMIVERSE_IOS_NATIVE__ = { version: 1 }
    expect(api.getInfo().bridges).toEqual(noBridges)
    attributes.set('data-tauri-mobile', 'android')
    delete host.__TAURI_INTERNALS__
    expect(api.getInfo()).toMatchObject({ kind: 'mobile', platform: 'android', bridges: noBridges })
  })

  test('reads fresh signals and freezes each snapshot and nested bridge flags', () => {
    const before = api.getInfo()
    nav.standalone = true
    const after = api.getInfo()
    expect(before.kind).toBe('browser')
    expect(after.kind).toBe('pwa')
    expect(Object.isFrozen(api)).toBe(true)
    expect(Object.isFrozen(after)).toBe(true)
    expect(Object.isFrozen(after.bridges)).toBe(true)
  })

  test('is safe without browser globals or optional browser APIs', () => {
    delete host.matchMedia
    expect(api.getInfo()).toEqual({ kind: 'browser', platform: 'unknown', isMobile: false, bridges: noBridges })
    delete globals.window
    delete globals.document
    expect(api.getInfo()).toEqual({ kind: 'browser', platform: 'unknown', isMobile: false, bridges: noBridges })
  })

  test('rejects reads from an inactive frontend generation', () => {
    const inactive = createFrontendClientAPI(() => { throw new Error('SPINDLE_FRONTEND_INACTIVE') })
    expect(() => inactive.getInfo()).toThrow('SPINDLE_FRONTEND_INACTIVE')
  })
})
