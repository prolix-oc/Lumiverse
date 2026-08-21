import { describe, expect, test } from 'bun:test'
import {
  CTX_AUTHORITY_MEMBERS,
  FRONTEND_AUTHORITY_MAP,
  frontendAuthorityPermission,
  projectCtxAuthorityMembers,
} from './frontend-authority-map'
import {
  CORE_SETTING_KEYS,
  settingsAuthorityRows,
} from './core-setting-keys'
import { LEGACY_CTX_MEMBERS, NO_AUTHORITY_CTX_MEMBERS } from './legacy-ctx-members'
import { assertContextAuthorityTotality, walkCallableContextLeaves } from './context-boundary'

const FREE_BASIS_PREFIXES = [
  'rest:', 'limb-e:', 'write-limb-i:', 'write-limb-ii:', 'pure-host-action:', 'shipped-twin:',
]

describe('frontend authority map', () => {
  test('has one permission for every canonical source', () => {
    const permissionsBySource = new Map<string, Set<string | null>>()
    for (const row of FRONTEND_AUTHORITY_MAP) {
      const permissions = permissionsBySource.get(row.source) ?? new Set<string | null>()
      permissions.add(row.permission)
      permissionsBySource.set(row.source, permissions)
    }
    for (const [source, permissions] of permissionsBySource) {
      expect(permissions.size, source).toBe(1)
    }
  })
  test('keeps every H7 surface in the canonical authority map', () => {
    const expected: Record<string, string | null> = {
      provider_icon: null,
      world_book_entry_editor: 'world_books',
      world_book_entry_table: null,
      character_card: null,
      character_library_grid: null,
      character_preview_panel: null,
      homepage_character_library: null,
      token_count_button: null,
      'productivity.settings.workspace': null,
      'quick_toolbar.workspace': null,
      'connections_picker.launcher': 'generation',
      'connections_picker.panel': 'generation',
      'activated_lore.indicator': null,
      'activated_lore.panel': null,
      'portrait_dock.workspace': 'ui_panels',
      'lorebook.half.action': null,
      'lorebook.half.workspace': 'world_books',
      'lorebook.enhanced.action': null,
      'lorebook.enhanced.workspace': 'world_books',
    }
    const rows = FRONTEND_AUTHORITY_MAP.filter((row) => row.surface === 'host_surface')
    expect(rows.map((row) => row.id)).toEqual(Object.keys(expected))
    for (const [id, permission] of Object.entries(expected)) {
      expect(frontendAuthorityPermission('host_surface', id)).toBe(permission)
    }
  })

  test('classifies every row and forbids grandfathered entries', () => {
    for (const row of FRONTEND_AUTHORITY_MAP) {
      expect(row.id).not.toMatch(/[*?\[\]{}]|\^|\$/)
      expect(row.id).not.toContain('...')
      expect(row.grandfathered).toBeUndefined()
      if (row.permission === null) {
        const bases = typeof row.freeBecause === 'string' ? [row.freeBecause] : row.freeBecause ?? []
        expect(bases.length).toBeGreaterThan(0)
        for (const basis of bases) {
          expect(FREE_BASIS_PREFIXES.some((prefix) => basis.startsWith(prefix)), `${row.id}: ${basis}`).toBeTrue()
        }
        expect(row.gatedBecause).toBeUndefined()
      } else {
        expect(row.gatedBecause).toBeString()
        expect(row.freeBecause).toBeUndefined()
      }
    }
  })

  test('projects direct context authority without permission drift', () => {
    const projected = new Map(CTX_AUTHORITY_MEMBERS.map((row) => [row.ctxLeaf, row]))
    for (const member of LEGACY_CTX_MEMBERS) {
      const row = FRONTEND_AUTHORITY_MAP.find((candidate) =>
        candidate.surface === 'legacy_ctx_member' && candidate.id === member.id,
      )
      expect(row).toBeDefined()
      expect(projected.get(row?.ctxLeaf)?.permission).toBe(member.permission)
    }
    expect(frontendAuthorityPermission('ctx_member', 'ctx.connections.models')).toBe('generation')
    expect(frontendAuthorityPermission('legacy_ctx_member', 'ctx.chats.updateMessage')).toBe('chats')
    for (const member of [
      'ctx.ui.registerConnectionEditorTab',
      'ctx.ui.connectionEditor.getEditedProfileId',
      'ctx.ui.connectionEditor.getState',
      'ctx.ui.connectionEditor.onChange',
      'ctx.ui.connectionEditor.onSaved',
    ]) {
      expect(frontendAuthorityPermission('legacy_ctx_member', member)).toBe('generation')
    }
  })

  test('keeps mapped context leaves disjoint from the exact free complement', () => {
    const mapped = new Set(CTX_AUTHORITY_MEMBERS.map((row) => row.ctxLeaf))
    for (const path of NO_AUTHORITY_CTX_MEMBERS) {
      expect(mapped.has(path), path).toBeFalse()
    }
    expect(mapped.has('ctx.ui.geometry.getUiScale')).toBeTrue()
    expect(mapped.has('ctx.ui.geometry.toLayoutPx')).toBeTrue()
    expect(mapped.has('ctx.ui.geometry.layoutViewportSize')).toBeTrue()
    expect(mapped.has('ctx.ui.geometry.layoutElementRect')).toBeTrue()
    expect(mapped.has('ctx.ui.geometry.createResizeController')).toBeTrue()
    expect(NO_AUTHORITY_CTX_MEMBERS).toContain('ctx.ui.registerCssComponent')
    expect(NO_AUTHORITY_CTX_MEMBERS).toContain('ctx.ui.registerHostIntentHandler')
  })

  test('projects a newly declared direct leaf before totality validation', () => {
    const row = {
      surface: 'ctx_member' as const,
      id: 'ctx.ui.geometry.fixture',
      source: 'ui.geometry',
      permission: null,
      ctxLeaf: 'ctx.ui.geometry.fixture',
      freeBecause: 'limb-e: pure geometry fixture leaf',
    }
    const projected = projectCtxAuthorityMembers([row])
    const context = { ui: { geometry: { fixture() {} } } }

    expect(() => assertContextAuthorityTotality(
      context,
      projected.map((member) => member.ctxLeaf!).filter(Boolean),
      [],
    )).not.toThrow()
    expect(() => assertContextAuthorityTotality(context, [], [])).toThrow(
      'CTX_AUTHORITY_UNCLASSIFIED:ctx.ui.geometry.fixture',
    )
  })

  test('projects each enumerated core setting from one source table', () => {
    const generated = settingsAuthorityRows()
    for (const setting of CORE_SETTING_KEYS) {
      for (const id of [
        `setting:${setting.key}`,
        `ctx.settings.core.get:${setting.key}`,
        `ctx.settings.core.watch:${setting.key}`,
      ]) {
        const mapRow = FRONTEND_AUTHORITY_MAP.find((row) => row.id === id)
        const generatedRow = generated.find((row) => row.id === id)
        expect(mapRow).toBeDefined()
        expect(generatedRow).toBeDefined()
        expect(Object.is(mapRow?.permission, setting.permission)).toBeTrue()
        expect(Object.is(mapRow?.source, setting.source)).toBeTrue()
        expect(Object.is(generatedRow?.permission, setting.permission)).toBeTrue()
        expect(Object.is(generatedRow?.source, setting.source)).toBeTrue()
      }
    }
  })

  test('walks callable and accessor leaves without invoking accessors', () => {
    let getterCalls = 0
    const fixture = {
      callable() {},
      nested: {
        accessor: Object.defineProperty({}, 'value', {
          configurable: true,
          get() {
            getterCalls += 1
            return () => {}
          },
        }),
      },
    }
    const leaves = walkCallableContextLeaves(fixture)
    expect(getterCalls).toBe(0)
    expect(leaves).toEqual(expect.arrayContaining([
      { path: 'ctx.callable', kind: 'callable' },
      { path: 'ctx.nested.accessor.value', kind: 'accessor' },
    ]))
  })

  test('uses exact paths for the explicit no-authority complement', () => {
    const paths = new Set<string>(NO_AUTHORITY_CTX_MEMBERS)
    expect(paths.size).toBe(NO_AUTHORITY_CTX_MEMBERS.length)
    for (const path of paths) {
      expect(path).toMatch(/^ctx(?:\.[A-Za-z][A-Za-z0-9_]*)+$/)
      expect(path).not.toMatch(/[?*\[\]{}]/)
    }
  })

  test('fails closed when a new callable leaf is not classified', () => {
    const fixture = { allowed() {}, excluded() {} }
    expect(() => assertContextAuthorityTotality(fixture, ['ctx.allowed'], ['ctx.excluded'])).not.toThrow()
    expect(() => assertContextAuthorityTotality(fixture, ['ctx.allowed'], [])).toThrow('CTX_AUTHORITY_UNCLASSIFIED:ctx.excluded')
  })
})
