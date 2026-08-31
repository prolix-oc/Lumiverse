/// <reference types="bun-types" />

import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'http://localhost/',
})
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
})

const {
  forgetExtensionIdentity,
  registerExtensionIdentity,
  stampExtensionRoot,
} = await import('./extension-root-stamp')

function createAttributeRoot(): Element {
  const attributes = new Map<string, string>()
  return {
    getAttribute(name) {
      return attributes.get(name) ?? null
    },
    setAttribute(name, value) {
      attributes.set(name, value)
    },
  } as unknown as Element
}

const extensionId = '00000000-0000-0000-0000-000000000001'

describe('extension root stamping', () => {
  test('writes UUID ownership and identifier metadata without making metadata authoritative', () => {
    const root = createAttributeRoot()
    registerExtensionIdentity(extensionId, 'lumiverse_suite')
    stampExtensionRoot(root, extensionId, 'data-spindle-extension-id')

    expect(root.getAttribute('data-spindle-extension-id')).toBe(extensionId)
    expect(root.getAttribute('data-spindle-ext-id')).toBe('lumiverse_suite')

    forgetExtensionIdentity(extensionId)
    const unloadedRoot = createAttributeRoot()
    stampExtensionRoot(unloadedRoot, extensionId, 'data-spindle-ext')
    expect(unloadedRoot.getAttribute('data-spindle-ext')).toBe(extensionId)
    expect(unloadedRoot.getAttribute('data-spindle-ext-id')).toBeNull()
  })

  test('keeps reserved root attributes behind stampExtensionRoot', async () => {
    const productionFiles = [
      'dom-helper.ts',
      'dom-injection-registry.ts',
      'loader.ts',
      'message-widgets.tsx',
      'placement-helper.ts',
      'sandbox-frame.ts',
    ]
    const source = await Promise.all(
      productionFiles.map((file) => readFile(resolve(import.meta.dir, file), 'utf8')),
    )
    const directWriter = /\.setAttribute\(\s*['"]data-spindle-(?:ext|extension-root|extension-id)['"]\s*,/g
    for (const [index, text] of source.entries()) {
      expect(text.match(directWriter), productionFiles[index]).toBeNull()
    }
  })
})
