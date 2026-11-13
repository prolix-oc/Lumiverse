import { describe, expect, test } from 'bun:test'
import { JSDOM } from 'jsdom'
import {
  filterEnabledFrontendContributions,
  filterEnabledCommandContributions,
  hasEnabledFrontendExtension,
  hasEnabledFrontendExtensionId,
  hasAvailableFrontendSurface,
} from './frontend-extension-availability'

describe('frontend extension availability', () => {
  test('key bindings and palette commands can reach backend-only extensions, but not disabled extensions', () => {
    expect(filterEnabledCommandContributions([
      { extensionId: 'backend', id: 'analyze' }, { extensionId: 'disabled', id: 'stale' }, { extensionId: 'removed', id: 'removed' },
    ], [{ id: 'backend', enabled: true, has_frontend: false }, { id: 'disabled', enabled: false, has_frontend: true }])).toEqual([{ extensionId: 'backend', id: 'analyze' }])
  })
  test('requires an installed, enabled frontend extension with the requested identifier', () => {
    const hasSuite = (extensions: Parameters<typeof hasEnabledFrontendExtension>[0]) => (
      hasEnabledFrontendExtension(extensions, 'lumiverse_suite')
    )

    expect(hasSuite(undefined)).toBe(false)
    expect(hasSuite([])).toBe(false)
    expect(hasSuite([{ identifier: 'another_extension', enabled: true, has_frontend: true }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: false, has_frontend: true }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: true, has_frontend: false }])).toBe(false)
    expect(hasSuite([{ identifier: 'lumiverse_suite', enabled: true, has_frontend: true }])).toBe(true)
  })

  test('requires the owning extension id for registered frontend contributions', () => {
    const extensions = [
      { id: 'suite', enabled: false, has_frontend: true },
      { id: 'backend-only', enabled: true, has_frontend: false },
      { id: 'active', enabled: true, has_frontend: true },
    ]

    expect(hasEnabledFrontendExtensionId(extensions, 'suite')).toBe(false)
    expect(hasEnabledFrontendExtensionId(extensions, 'backend-only')).toBe(false)
    expect(hasEnabledFrontendExtensionId(extensions, 'active')).toBe(true)
    expect(filterEnabledFrontendContributions([
      { id: 'suite-widget', extensionId: 'suite' },
      { id: 'active-widget', extensionId: 'active' },
    ], extensions)).toEqual([{ id: 'active-widget', extensionId: 'active' }])
  })

  test('retained Suite homepage roots release their native surface when unavailable', () => {
    const dom = new JSDOM('<div data-spindle-extension-root="suite" data-spindle-ext-id="lumiverse_suite"><div data-ready="true"></div></div>')
    const installed = { id: 'suite', identifier: 'lumiverse_suite', enabled: true, has_frontend: true }
    expect(hasAvailableFrontendSurface(dom.window.document, '[data-ready]', [installed])).toBe(true)
    for (const extensions of [[], [{ ...installed, enabled: false }], [{ ...installed, has_frontend: false }]]) {
      expect(hasAvailableFrontendSurface(dom.window.document, '[data-ready]', extensions)).toBe(false)
    }
    expect(dom.window.document.querySelector('[data-ready]')).not.toBeNull()
    dom.window.close()
  })
})
