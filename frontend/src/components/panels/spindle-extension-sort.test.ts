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
