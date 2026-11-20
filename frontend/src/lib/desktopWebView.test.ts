import { afterAll, beforeEach, expect, test } from 'bun:test'
import { getTauriMobilePlatform, hasTauriDesktopBridge, isMacTauriWebView, isTauriDesktop, isTauriMobile } from './desktopWebView'

const globals = globalThis as unknown as Record<string, unknown>
const originalWindow = globals.window
const originalDocument = globals.document
const attributes = new Map<string, string>()
let host: Record<string, unknown>

beforeEach(() => {
  attributes.clear()
  host = {}
  globals.window = host
  globals.document = { documentElement: {
    hasAttribute: (name: string) => attributes.has(name),
    getAttribute: (name: string) => attributes.get(name),
  } }
})
afterAll(() => { globals.window = originalWindow; globals.document = originalDocument })

test('the Android Tauri bridge never enables desktop integrations', () => {
  host.__TAURI_INTERNALS__ = {}
  host.__LUMIVERSE_MOBILE__ = true
  // A stale desktop attribute must not override the native mobile identity.
  attributes.set('data-tauri-desktop', '')
  attributes.set('data-platform', 'macos')
  expect(isTauriMobile()).toBe(true)
  expect(hasTauriDesktopBridge()).toBe(false)
  expect(isTauriDesktop()).toBe(false)
  expect(isMacTauriWebView()).toBe(false)
})

test('the mobile DOM marker also prevents desktop bridge calls', () => {
  host.__TAURI_INTERNALS__ = {}
  attributes.set('data-tauri-mobile', 'android')
  expect(isTauriMobile()).toBe(true)
  expect(hasTauriDesktopBridge()).toBe(false)
})

test('desktop Tauri keeps its bridge and macOS WebView behavior', () => {
  host.__TAURI_INTERNALS__ = {}
  attributes.set('data-tauri-desktop', '')
  attributes.set('data-platform', 'macos')
  expect(isTauriMobile()).toBe(false)
  expect(hasTauriDesktopBridge()).toBe(true)
  expect(isTauriDesktop()).toBe(true)
  expect(isMacTauriWebView()).toBe(true)
})

test('a browser on Android has no native Tauri bridge', () => {
  attributes.set('data-platform', 'android')
  expect(isTauriMobile()).toBe(false)
  expect(hasTauriDesktopBridge()).toBe(false)
  expect(isTauriDesktop()).toBe(false)
})

test('iOS keeps its platform identity without enabling desktop integrations', () => {
  host.__TAURI_INTERNALS__ = {}
  host.__LUMIVERSE_MOBILE__ = true
  host.__LUMIVERSE_PLATFORM__ = 'ios'
  attributes.set('data-tauri-mobile', 'ios')
  expect(getTauriMobilePlatform()).toBe('ios')
  expect(hasTauriDesktopBridge()).toBe(false)
  expect(isMacTauriWebView()).toBe(false)
})

test('Android identity and ordinary browsers remain distinct', () => {
  expect(getTauriMobilePlatform()).toBeNull()
  host.__LUMIVERSE_MOBILE__ = true
  expect(getTauriMobilePlatform()).toBe('android')
  attributes.set('data-tauri-mobile', 'ios')
  expect(getTauriMobilePlatform()).toBe('ios')
})
