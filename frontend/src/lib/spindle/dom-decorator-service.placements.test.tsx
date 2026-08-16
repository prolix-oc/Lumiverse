/// <reference types="bun-types" />

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import { resolve } from 'node:path'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  MutationObserver: dom.window.MutationObserver,
  requestAnimationFrame: (cb: FrameRequestCallback) => dom.window.setTimeout(() => cb(Date.now()), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => dom.window.clearTimeout(id),
})

const {
  CANONICAL_MOUNT_PLACEMENTS,
  createSpindleMountHost,
  EXISTING_FRONTEND_MOUNT_STAMPS,
  flushDomDecoratorWork,
  getDomDecoratorService,
  PHYSICAL_MOUNT_PLACEMENTS,
  resetDomDecoratorServicesForTests,
} = await import('./dom-decorator-service')
const { installSpindleExtensionDiagnostics } = await import('./extension-diagnostics')
type PhysicalMountPlacement = (typeof PHYSICAL_MOUNT_PLACEMENTS)[number]

const OWNER = '00000000-0000-0000-0000-000000000013'
const GENERATION = 4

afterAll(() => {
  resetDomDecoratorServicesForTests()
})

beforeEach(() => {
  document.body.replaceChildren()
  resetDomDecoratorServicesForTests()
  installSpindleExtensionDiagnostics()
})

function assertPlacement(row: PhysicalMountPlacement | undefined, scope: string): void {
  expect(row).toBeTruthy()
  if (!row) return
  const host = createSpindleMountHost({
    mount: row.literal,
    scope,
    owner: OWNER,
    generation: GENERATION,
  })
  document.body.append(host)
  const service = getDomDecoratorService()
  service.registerAnchor({
    mount: row.literal,
    scope,
    owner: OWNER,
    generation: GENERATION,
    node: host,
  })
  flushDomDecoratorWork()
  expect(host.getAttribute('data-spindle-mount')).toBe(row.literal)
  expect(service.getRoot(OWNER, GENERATION, row.literal, scope)?.getAttribute('data-spindle-extension-root')).toBe(OWNER)
}

function findPlacement(literal: string, hostName: string): PhysicalMountPlacement | undefined {
  return PHYSICAL_MOUNT_PLACEMENTS.find((row) => row.literal === literal && row.hostName === hostName)
}

describe('dom decorator service placements', () => {
  test('asserts exactly 64 physical mount placements', () => {
    expect(CANONICAL_MOUNT_PLACEMENTS).toHaveLength(58)
    expect(PHYSICAL_MOUNT_PLACEMENTS).toHaveLength(64)
    const ids = PHYSICAL_MOUNT_PLACEMENTS.map((row) => row.placementId)
    expect(new Set(ids).size).toBe(64)
    expect(PHYSICAL_MOUNT_PLACEMENTS.filter((row) => row.hostName === 'BubbleMessageDefault')).toHaveLength(5)
    expect(PHYSICAL_MOUNT_PLACEMENTS.filter((row) => row.hostName === 'MinimalMessageDefault')).toHaveLength(5)
    expect(PHYSICAL_MOUNT_PLACEMENTS.filter((row) => row.literal === 'settings_section')).toHaveLength(2)
  })

  test('asserts BubbleMessageDefault physical placement for message_header', () => {
    const row = findPlacement('message_header', 'BubbleMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:bubble:header')
    assertPlacement(row, 'message:msg-1:bubble:header')
  })

  test('asserts MinimalMessageDefault physical placement for message_header', () => {
    const row = findPlacement('message_header', 'MinimalMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:minimal:header')
    assertPlacement(row, 'message:msg-1:minimal:header')
  })

  test('asserts BubbleMessageDefault physical placement for message_body_before', () => {
    const row = findPlacement('message_body_before', 'BubbleMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:bubble:body-before')
    assertPlacement(row, 'message:msg-1:bubble:body-before')
  })

  test('asserts MinimalMessageDefault physical placement for message_body_before', () => {
    const row = findPlacement('message_body_before', 'MinimalMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:minimal:body-before')
    assertPlacement(row, 'message:msg-1:minimal:body-before')
  })

  test('asserts BubbleMessageDefault physical placement for message_body_after', () => {
    const row = findPlacement('message_body_after', 'BubbleMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:bubble:body-after')
    assertPlacement(row, 'message:msg-1:bubble:body-after')
  })

  test('asserts MinimalMessageDefault physical placement for message_body_after', () => {
    const row = findPlacement('message_body_after', 'MinimalMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:minimal:body-after')
    assertPlacement(row, 'message:msg-1:minimal:body-after')
  })

  test('asserts BubbleMessageDefault physical placement for message_footer', () => {
    const row = findPlacement('message_footer', 'BubbleMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:bubble:footer')
    assertPlacement(row, 'message:msg-1:bubble:footer')
  })

  test('asserts MinimalMessageDefault physical placement for message_footer', () => {
    const row = findPlacement('message_footer', 'MinimalMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:minimal:footer')
    assertPlacement(row, 'message:msg-1:minimal:footer')
  })

  test('asserts BubbleMessageDefault physical placement for message_swipe_indicators', () => {
    const row = findPlacement('message_swipe_indicators', 'BubbleMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:bubble:swipe-indicators')
    assertPlacement(row, 'message:msg-1:bubble:swipe-indicators')
  })

  test('asserts MinimalMessageDefault physical placement for message_swipe_indicators', () => {
    const row = findPlacement('message_swipe_indicators', 'MinimalMessageDefault')
    expect(row?.scopeTemplate).toBe('message:${message.id}:minimal:swipe-indicators')
    assertPlacement(row, 'message:msg-1:minimal:swipe-indicators')
  })

  test('asserts SettingsModal physical placement for settings_section', () => {
    const row = findPlacement('settings_section', 'SettingsModal')
    expect(row?.scopeTemplate).toBe('settings-section:${activeTabId}:modal')
    assertPlacement(row, 'settings-section:general:modal')
  })

  test('asserts ProductivitySettings physical placement for settings_section', () => {
    const row = findPlacement('settings_section', 'ProductivitySettings')
    expect(row?.scopeTemplate).toBe('settings-section:productivity:${cardId}')
    assertPlacement(row, 'settings-section:productivity:toolbar')
  })

  test('asserts existing frontend data-spindle-mount stamps are present', async () => {
    const srcRoot = resolve(import.meta.dir, '../..')
    const glob = new Bun.Glob('**/*.{ts,tsx}')
    const found = new Map<string, string[]>()

    for await (const path of glob.scan({ cwd: srcRoot, onlyFiles: true })) {
      if (path.includes('.test.') || path.includes('.isolated.')) continue
      const text = await Bun.file(resolve(srcRoot, path)).text()
      for (const match of text.matchAll(/data-spindle-mount=["']([^"']+)["']/g)) {
        const literal = match[1]
        const list = found.get(literal) ?? []
        list.push(`frontend/src/${path.replaceAll('\\', '/')}`)
        found.set(literal, list)
      }
    }

    for (const stamp of EXISTING_FRONTEND_MOUNT_STAMPS) {
      const files = found.get(stamp.literal) ?? []
      expect(files.some((file) => file.endsWith(stamp.file.replace(/^frontend\/src\//, '')) || file.includes(stamp.file.replace(/^frontend\/src\//, ''))), stamp.literal).toBe(true)
    }
  })
})
