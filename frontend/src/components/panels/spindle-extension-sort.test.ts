import { expect, test } from 'bun:test'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import { filterExtensions, reconcileExtensionOrder, sortExtensions } from './spindle-extension-sort'

function extension(overrides: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: 'id',
    identifier: 'identifier',
    name: 'Extension',
    version: '1.0.0',
    author: 'Author',
    description: '',
    github: '',
    homepage: '',
    permissions: [],
    granted_permissions: [],
    enabled: true,
    installed_at: 0,
    updated_at: 0,
    has_frontend: false,
    has_backend: true,
    status: 'stopped',
    metadata: {},
    ...overrides,
  }
}

const extensions = [
  extension({ id: '1', identifier: 'zebra', name: 'zebra', installed_at: 10, updated_at: 30 }),
  extension({ id: '2', identifier: 'alpha-ten', name: 'Alpha 10', installed_at: 30, updated_at: 20, author: 'Kitty' }),
  extension({ id: '3', identifier: 'alpha-two', name: 'alpha 2', installed_at: 20, updated_at: 10, permissions: ['image_gen'] as any }),
]

test('sorts extensions by installation and update dates with the newest first', () => {
  expect(sortExtensions(extensions, 'installed').map((item) => item.id)).toEqual(['2', '3', '1'])
  expect(sortExtensions(extensions, 'updated').map((item) => item.id)).toEqual(['1', '2', '3'])
})

test('sorts extension names alphabetically in both directions without mutating the source', () => {
  expect(sortExtensions(extensions, 'name-asc').map((item) => item.id)).toEqual(['3', '2', '1'])
  expect(sortExtensions(extensions, 'name-desc').map((item) => item.id)).toEqual(['1', '2', '3'])
  expect(extensions.map((item) => item.id)).toEqual(['1', '2', '3'])
})

test('reconciles persisted manual order and appends new extensions without stale ids', () => {
  expect(reconcileExtensionOrder(extensions, ['3', 'missing', '1', '3'])).toEqual(['3', '1', '2'])
  expect(sortExtensions(extensions, 'manual', ['3', '1', '2']).map((item) => item.id)).toEqual(['3', '1', '2'])
})

test('filters visible extension metadata and permissions case-insensitively', () => {
  expect(filterExtensions(extensions, 'kitty').map((item) => item.id)).toEqual(['2'])
  expect(filterExtensions(extensions, 'IMAGE GEN').map((item) => item.id)).toEqual(['3'])
  expect(filterExtensions(extensions, 'alpha').map((item) => item.id)).toEqual(['2', '3'])
  expect(filterExtensions(extensions, '   ')).toHaveLength(3)
})

const activityExtensions = [
  extension({ id: 'running', name: 'Lumi Toolkit', enabled: true, status: 'running' }),
  extension({ id: 'disabled', name: 'LumiRealm', enabled: false, status: 'stopped' }),
  extension({ id: 'errored', name: 'LumiMind', enabled: true, status: 'error' }),
  extension({ id: 'frontend', name: 'World Info', enabled: true, status: 'stopped', has_backend: false, has_frontend: true }),
]

test('activity filters follow the enabled toggle, including errored and frontend-only extensions', () => {
  expect(filterExtensions(activityExtensions, '', 'active').map((item) => item.id))
    .toEqual(['running', 'errored', 'frontend'])
  expect(filterExtensions(activityExtensions, '', 'inactive').map((item) => item.id))
    .toEqual(['disabled'])
  expect(filterExtensions(activityExtensions, '', 'all')).toEqual(activityExtensions)
})

test('combines activity filters with search and handles whitespace and empty results', () => {
  expect(filterExtensions(activityExtensions, ' LUMI ', 'active').map((item) => item.id))
    .toEqual(['running', 'errored'])
  expect(filterExtensions(activityExtensions, 'lumi', 'inactive').map((item) => item.id))
    .toEqual(['disabled'])
  expect(filterExtensions(activityExtensions, '  ', 'inactive').map((item) => item.id))
    .toEqual(['disabled'])
  expect(filterExtensions(activityExtensions, 'World Info', 'inactive')).toEqual([])
  expect(filterExtensions([], '', 'active')).toEqual([])
})

test('activity filters preserve manual order and do not mutate the installed list', () => {
  const originalOrder = activityExtensions.map((item) => item.id)
  const manualOrder = ['frontend', 'disabled', 'errored', 'running']
  expect(sortExtensions(filterExtensions(activityExtensions, '', 'active'), 'manual', manualOrder)
    .map((item) => item.id)).toEqual(['frontend', 'errored', 'running'])
  expect(activityExtensions.map((item) => item.id)).toEqual(originalOrder)
  expect(sortExtensions(activityExtensions, 'manual', manualOrder).map((item) => item.id)).toEqual(manualOrder)
})

test('extensions move between activity filters after their enabled state changes', () => {
  const toggled = activityExtensions.map((item) => item.id === 'running' ? { ...item, enabled: false } : item)
  expect(filterExtensions(toggled, '', 'active').map((item) => item.id)).toEqual(['errored', 'frontend'])
  expect(filterExtensions(toggled, '', 'inactive').map((item) => item.id)).toEqual(['running', 'disabled'])
})

test('updatable filters follow detected update ids for both active and inactive extensions', () => {
  const updates = new Set(['running', 'disabled', 'uninstalled'])
  expect(filterExtensions(activityExtensions, '', 'updatable', updates).map((item) => item.id))
    .toEqual(['running', 'disabled'])
  expect(filterExtensions(activityExtensions, '', 'updatable')).toEqual([])
  expect(filterExtensions(activityExtensions, '', 'active', updates).map((item) => item.id))
    .toEqual(['running', 'errored', 'frontend'])
})

test('updatable filters combine with search and preserve manual ordering without modifying installed extensions', () => {
  const updates = new Set(['running', 'disabled'])
  expect(filterExtensions(activityExtensions, ' TOOLKIT ', 'updatable', updates).map((item) => item.id))
    .toEqual(['running'])
  expect(filterExtensions(activityExtensions, 'World Info', 'updatable', updates)).toEqual([])
  expect(sortExtensions(filterExtensions(activityExtensions, '  ', 'updatable', updates), 'manual', ['disabled', 'running'])
    .map((item) => item.id)).toEqual(['disabled', 'running'])
  expect(activityExtensions.map((item) => item.id)).toEqual(['running', 'disabled', 'errored', 'frontend'])
})
