import { describe, expect, test } from 'bun:test'
import type { ExtensionInfo } from 'lumiverse-spindle-types'
import { compareFrontendHydrationPriority } from './frontend-startup-priority'

function extension(overrides: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: overrides.identifier ?? 'extension',
    identifier: 'extension',
    name: 'Extension',
    version: '1.0.0',
    author: 'Test',
    description: '',
    github: '',
    homepage: '',
    permissions: [],
    granted_permissions: [],
    enabled: true,
    installed_at: 0,
    updated_at: 0,
    has_frontend: true,
    has_backend: false,
    status: 'running',
    metadata: {},
    ...overrides,
  }
}

describe('frontend startup priority', () => {
  test('places the homepage suite first without disturbing the existing privileged ordering', () => {
    const queue = [
      extension({ identifier: 'newest', installed_at: 30 }),
      extension({
        identifier: 'privileged',
        granted_permissions: ['ui_panels'],
        installed_at: 10,
      }),
      extension({
        identifier: 'lumiverse_suite',
        granted_permissions: ['app_manipulation', 'ui_panels'],
        installed_at: 1,
      }),
      extension({ identifier: 'older', installed_at: 20 }),
    ].sort(compareFrontendHydrationPriority)

    expect(queue.map(item => item.identifier)).toEqual([
      'lumiverse_suite',
      'privileged',
      'newest',
      'older',
    ])
  })
})
