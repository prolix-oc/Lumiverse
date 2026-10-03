import { describe, expect, test } from 'bun:test'

import {
  SUITE_BARE_INPUT_ACTION_IDS,
  SUITE_EXTENSION_ID,
  applyComposerExtensionActionOrder,
  buildExtensionActionCatalog,
  extensionActionIdentity,
  extensionActionKey,
  extensionRuntimeKey,
  isExtensionActionOrderPermutation,
  mergeExtensionActionOrder,
  normalizeComposerExtensionActions,
  normalizeToolbarExtensionActions,
  pinExtensionActionToFirstSlot,
  resolveStoredExtensionActionKey,
  setComposerExtensionActionVisible,
  setToolbarExtensionActionVisible,
  type ExtensionActionRegistration,
} from './extensionActionPreferences'

// Every expected key is written out literally from the agreed wire format
// (`'ext-action:' + JSON.stringify([kind, extensionId, contributionId])`) instead
// of being recomputed through the module under test.

const SUITE_HALF = 'lumiverse_suite.lorebook.open_half'
const SUITE_ENHANCED = 'lumiverse_suite.lorebook.open_enhanced'
const SUITE_CONNECTIONS = 'lumiverse_suite.connections_picker.open'

const KEY_INPUT = 'ext-action:["input","owner","contrib"]'
const KEY_DRAWER = 'ext-action:["drawer","owner","settings"]'

/** What a pre-stable-key build persisted for KEY_INPUT. */
const LEGACY_INPUT = 'input-action:owner:spindle:owner:action:contrib:4'
/** What a pre-stable-key build persisted for KEY_DRAWER. */
const LEGACY_DRAWER = 'spindle:owner:tab:settings:9'

const LF = String.fromCharCode(10)
const BACKSLASH = String.fromCharCode(92)

function inputAction(extensionId: string, contributionId: unknown, runtimeId: string): ExtensionActionRegistration {
  return { kind: 'input', extensionId, contributionId, runtimeId }
}

function drawerTab(extensionId: string, contributionId: unknown, runtimeId: string): ExtensionActionRegistration {
  return { kind: 'drawer', extensionId, contributionId, runtimeId }
}

const OWNER_CATALOG = buildExtensionActionCatalog([
  inputAction('owner', 'contrib', 'runtime-input'),
  drawerTab('owner', 'settings', 'runtime-drawer'),
])

describe('extension action keys', () => {
  test('serializes the tuple as JSON so separator-bearing ids cannot collide', () => {
    const first = extensionActionKey('input', 'owner', 'a:b')
    const second = extensionActionKey('input', 'owner:a', 'b')

    expect(first).toBe('ext-action:["input","owner","a:b"]')
    expect(second).toBe('ext-action:["input","owner:a","b"]')
    expect(first).not.toBe(second)
    // A colon join would have collided; that is exactly why the key is JSON.
    expect(['input', 'owner', 'a:b'].join(':')).toBe(['input', 'owner:a', 'b'].join(':'))
  })

  test('keeps Unicode and newlines verbatim inside the key', () => {
    const contributionId = `café🎉:ünïcode${LF}line`
    const key = extensionActionKey('input', 'owner', contributionId)
    const escapedNewline = BACKSLASH + 'n'

    expect(key).toBe(`ext-action:["input","owner","café🎉:ünïcode${escapedNewline}line"]`)
    expect(key).toContain('café🎉:ünïcode')
    expect(key).toContain('line')
    expect(key.includes(LF)).toBe(false)
  })

  test('distinguishes kinds that share an owner and contribution id', () => {
    expect(extensionActionKey('input', 'owner', 'contrib')).toBe(KEY_INPUT)
    expect(extensionActionKey('drawer', 'owner', 'contrib')).toBe('ext-action:["drawer","owner","contrib"]')
    expect(extensionActionKey('input', 'owner', 'contrib')).not.toBe(extensionActionKey('drawer', 'owner', 'contrib'))
  })

  test('keeps the three first-party Suite input keys bare', () => {
    expect([...SUITE_BARE_INPUT_ACTION_IDS]).toEqual([
      'lumiverse_suite.lorebook.open_half',
      'lumiverse_suite.lorebook.open_enhanced',
      'lumiverse_suite.connections_picker.open',
    ])
    expect(SUITE_EXTENSION_ID).toBe('lumiverse_suite')
    expect(extensionActionKey('input', SUITE_EXTENSION_ID, SUITE_HALF)).toBe('lumiverse_suite.lorebook.open_half')
    expect(extensionActionKey('input', SUITE_EXTENSION_ID, SUITE_ENHANCED)).toBe('lumiverse_suite.lorebook.open_enhanced')
    expect(extensionActionKey('input', SUITE_EXTENSION_ID, SUITE_CONNECTIONS)).toBe('lumiverse_suite.connections_picker.open')

    const suiteCatalog = buildExtensionActionCatalog([
      inputAction(SUITE_EXTENSION_ID, SUITE_HALF, 'spindle:lumiverse_suite:action:lumiverse_suite.lorebook.open_half:4'),
    ])
    expect(suiteCatalog.entries[0].key).toBe('lumiverse_suite.lorebook.open_half')
    expect(resolveStoredExtensionActionKey(
      'input-action:lumiverse_suite:spindle:lumiverse_suite:action:lumiverse_suite.lorebook.open_half:6',
      suiteCatalog,
    )).toBe('lumiverse_suite.lorebook.open_half')
  })

  test('namespaces the same contribution for another owner or kind', () => {
    expect(extensionActionKey('input', 'other_owner', SUITE_HALF))
      .toBe('ext-action:["input","other_owner","lumiverse_suite.lorebook.open_half"]')
    expect(extensionActionKey('drawer', SUITE_EXTENSION_ID, SUITE_HALF))
      .toBe('ext-action:["drawer","lumiverse_suite","lumiverse_suite.lorebook.open_half"]')

    const foreign = buildExtensionActionCatalog([inputAction('other_owner', SUITE_HALF, 'runtime-foreign')])
    expect(foreign.entries[0].key).toBe('ext-action:["input","other_owner","lumiverse_suite.lorebook.open_half"]')
    // The bare Suite key never resolves against another owner.
    expect(resolveStoredExtensionActionKey(SUITE_HALF, foreign)).toBeNull()
  })

  test('falls back to an ephemeral runtime key for unusable contribution metadata', () => {
    const expected = 'ext-runtime:["input","owner","runtime-9"]'
    for (const contributionId of [undefined, null, '', '   ', `${LF}${String.fromCharCode(9)}`, 42, true, { id: 'x' }, ['a']]) {
      expect(extensionActionIdentity(inputAction('owner', contributionId, 'runtime-9')))
        .toEqual({ key: expected, runtime: true })
    }

    expect(extensionRuntimeKey('drawer', 'owner', 'runtime')).toBe('ext-runtime:["drawer","owner","runtime"]')

    const catalog = buildExtensionActionCatalog([inputAction('owner', '   ', 'runtime-9')])
    expect(catalog.entries[0]).toEqual({
      kind: 'input',
      extensionId: 'owner',
      contributionId: null,
      runtimeId: 'runtime-9',
      key: 'ext-runtime:["input","owner","runtime-9"]',
      runtime: true,
      ambiguous: false,
    })
  })

  test('keeps runtime handles distinct and resolvable only inside the live session', () => {
    const first = extensionActionIdentity(inputAction('owner', undefined, 'spindle:owner:action:undefined:9'))
    const second = extensionActionIdentity(inputAction('owner', undefined, 'spindle:owner:action:undefined:10'))

    expect(first).toEqual({ key: 'ext-runtime:["input","owner","spindle:owner:action:undefined:9"]', runtime: true })
    expect(second.key).toBe('ext-runtime:["input","owner","spindle:owner:action:undefined:10"]')
    expect(first.key).not.toBe(second.key)

    const runtimeKey = first.key
    const catalog = buildExtensionActionCatalog([
      inputAction('owner', undefined, 'spindle:owner:action:undefined:9'),
    ])
    expect(resolveStoredExtensionActionKey(runtimeKey, catalog)).toBe(runtimeKey)
    expect(resolveStoredExtensionActionKey(runtimeKey, buildExtensionActionCatalog([]))).toBeNull()
  })
})

describe('duplicate logical registrations', () => {
  const duplicateCatalog = buildExtensionActionCatalog([
    inputAction('owner', 'shared', 'runtime-a'),
    inputAction('owner', 'shared', 'runtime-b'),
    inputAction('owner', 'solo', 'runtime-c'),
  ])

  test('withholds a shared tuple while duplicate registrations live', () => {
    expect(duplicateCatalog.entries.map((entry) => entry.key)).toEqual([
      'ext-action:["input","owner","shared"]',
      'ext-action:["input","owner","shared"]',
      'ext-action:["input","owner","solo"]',
    ])
    expect(duplicateCatalog.entries.map((entry) => entry.ambiguous)).toEqual([true, true, false])
    expect(duplicateCatalog.entries.map((entry) => entry.runtimeId))
      .toEqual(['runtime-a', 'runtime-b', 'runtime-c'])
  })

  test('preserves the saved strings of a withheld tuple', () => {
    const stored = 'input-action:owner:spindle:owner:action:shared:3'

    expect(resolveStoredExtensionActionKey(stored, duplicateCatalog)).toBeNull()
    expect(normalizeToolbarExtensionActions({ visibleIds: [stored], iconOrder: [stored] }, duplicateCatalog))
      .toEqual({ visibleIds: [stored], iconOrder: [stored] })
  })

  test('restores the surviving registration once the duplicate disappears', () => {
    const surviving = buildExtensionActionCatalog([inputAction('owner', 'shared', 'runtime-a')])

    expect(surviving.entries[0].ambiguous).toBe(false)
    expect(resolveStoredExtensionActionKey('input-action:owner:spindle:owner:action:shared:3', surviving))
      .toBe('ext-action:["input","owner","shared"]')
  })

  test('does not guess a unique tuple when a colliding tuple is duplicate-withheld', () => {
    // A stored drawer counter string matches BOTH logical tuples: the first has
    // contributionId 'b:tab:c', the second 'b' with the tab runtime id supplying
    // the remaining 'tab:c' segments. The second tuple is registered twice, so its
    // entries are ambiguous and the match must refuse to resolve - even though the
    // ambiguous entries are the only ones that make the match non-unique.
    const collidingDrawer = (runtimeId: string): ExtensionActionRegistration =>
      drawerTab('a', 'b:tab:c', runtimeId)
    const uniqueDrawer = (runtimeId: string): ExtensionActionRegistration =>
      ({ kind: 'drawer', extensionId: 'a:tab:b', contributionId: 'c', runtimeId })
    const stored = 'spindle:a:tab:b:tab:c:7'

    const duplicateSecond = buildExtensionActionCatalog([
      collidingDrawer('r1'),
      uniqueDrawer('r2'),
      uniqueDrawer('r3'),
    ])
    expect(duplicateSecond.entries.map((entry) => [entry.key, entry.ambiguous])).toEqual([
      ['ext-action:["drawer","a","b:tab:c"]', false],
      ['ext-action:["drawer","a:tab:b","c"]', true],
      ['ext-action:["drawer","a:tab:b","c"]', true],
    ])
    // Ambiguous entries still contribute their prefix, so this is a two-tuple match.
    expect(resolveStoredExtensionActionKey(stored, duplicateSecond)).toBeNull()
    // Registration order must not change the answer.
    const duplicateFirst = buildExtensionActionCatalog([
      uniqueDrawer('r2'),
      uniqueDrawer('r3'),
      collidingDrawer('r1'),
    ])
    expect(resolveStoredExtensionActionKey(stored, duplicateFirst)).toBeNull()

    // The same string with only the duplicate owner present is still withheld.
    const duplicateOnly = buildExtensionActionCatalog([uniqueDrawer('r2'), uniqueDrawer('r3')])
    expect(resolveStoredExtensionActionKey(stored, duplicateOnly)).toBeNull()

    // Drop one duplicate and the ambiguous owner is still a colliding match, so
    // the string is still preserved: two distinct logical tuples match.
    const survived = buildExtensionActionCatalog([collidingDrawer('r1'), uniqueDrawer('r2')])
    expect(resolveStoredExtensionActionKey(stored, survived)).toBeNull()
    // With only one of the two tuples left, that tuple is unambiguous and resolves.
    const onlyFirst = buildExtensionActionCatalog([collidingDrawer('r1')])
    expect(resolveStoredExtensionActionKey(stored, onlyFirst)).toBe('ext-action:["drawer","a","b:tab:c"]')
    const onlySecond = buildExtensionActionCatalog([uniqueDrawer('r2')])
    expect(resolveStoredExtensionActionKey(stored, onlySecond)).toBe('ext-action:["drawer","a:tab:b","c"]')
  })

  test('preserves both preference arrays while a colliding tuple is withheld', () => {
    const collidingDrawer = (runtimeId: string): ExtensionActionRegistration =>
      drawerTab('a', 'b:tab:c', runtimeId)
    const uniqueDrawer = (runtimeId: string): ExtensionActionRegistration =>
      ({ kind: 'drawer', extensionId: 'a:tab:b', contributionId: 'c', runtimeId })
    const stored = 'spindle:a:tab:b:tab:c:7'
    const catalog = buildExtensionActionCatalog([
      collidingDrawer('r1'),
      uniqueDrawer('r2'),
      uniqueDrawer('r3'),
    ])

    // Every normalizer preserves the literal original string, never a guess.
    expect(normalizeToolbarExtensionActions({ visibleIds: [stored], iconOrder: [stored, 'profile'] }, catalog))
      .toEqual({ visibleIds: [stored], iconOrder: [stored, 'profile'] })
    expect(normalizeComposerExtensionActions({ order: [stored, 'home'], hidden: [stored] }, catalog))
      .toEqual({ order: [stored, 'home'], hidden: [stored] })
    // Neither explicit edit retargets it either.
    expect(setToolbarExtensionActionVisible({ visibleIds: [stored], iconOrder: [stored] }, catalog, stored, false))
      .toEqual({ visibleIds: [], iconOrder: [stored] })
    expect(setComposerExtensionActionVisible({ order: [stored], hidden: [] }, catalog, stored, false))
      .toEqual({ order: [stored], hidden: [stored] })
  })
})

describe('legacy counter keys', () => {
  test('resolves the literal input and drawer prefixes for any positive counter', () => {
    expect(resolveStoredExtensionActionKey('input-action:owner:spindle:owner:action:contrib:7', OWNER_CATALOG))
      .toBe(KEY_INPUT)
    expect(resolveStoredExtensionActionKey('input-action:owner:spindle:owner:action:contrib:912', OWNER_CATALOG))
      .toBe(KEY_INPUT)
    expect(resolveStoredExtensionActionKey('spindle:owner:tab:settings:12', OWNER_CATALOG))
      .toBe(KEY_DRAWER)
  })

  test('rejects everything that is not a plain positive decimal suffix', () => {
    const prefix = 'input-action:owner:spindle:owner:action:contrib:'
    const suffixes = [
      '0',
      '01',
      '007',
      '',
      ':1',
      '7a',
      'a',
      `7${LF}`,
      `7${String.fromCharCode(9)}`,
      ' 7',
      '7 ',
      '-1',
      '+1',
      '1.0',
      '1e2',
      '٣',
    ]

    for (const suffix of suffixes) {
      expect(resolveStoredExtensionActionKey(`${prefix}${suffix}`, OWNER_CATALOG)).toBeNull()
    }
    // Old counters resolve even though the live registration has none.
    expect(resolveStoredExtensionActionKey(`${prefix}10`, OWNER_CATALOG)).toBe(KEY_INPUT)
  })

  test('does not split unrelated colon strings or cross kinds', () => {
    expect(resolveStoredExtensionActionKey('spindle:owner:tab:contrib:4', OWNER_CATALOG)).toBeNull()
    expect(resolveStoredExtensionActionKey('input-action:owner:spindle:owner:action:other:4', OWNER_CATALOG)).toBeNull()
    expect(resolveStoredExtensionActionKey('input-action:owner:spindle:owner:action:contrib:4:extra', OWNER_CATALOG)).toBeNull()
    expect(resolveStoredExtensionActionKey('input-action:owner:spindle:owner:action:contrib', OWNER_CATALOG)).toBeNull()
    expect(resolveStoredExtensionActionKey('native:profile:3', OWNER_CATALOG)).toBeNull()
  })

  test('preserves legacy strings while the contributing extension is absent', () => {
    const absent = buildExtensionActionCatalog([])

    expect(resolveStoredExtensionActionKey(LEGACY_INPUT, absent)).toBeNull()
    expect(normalizeToolbarExtensionActions({ visibleIds: [LEGACY_INPUT], iconOrder: [LEGACY_INPUT, 'profile'] }, absent))
      .toEqual({ visibleIds: [LEGACY_INPUT], iconOrder: [LEGACY_INPUT, 'profile'] })
  })

  test('migrates the same strings once the extension is registered again', () => {
    const beforeRegistration = { visibleIds: [LEGACY_INPUT], iconOrder: [LEGACY_INPUT, LEGACY_DRAWER] }

    expect(normalizeToolbarExtensionActions(beforeRegistration, buildExtensionActionCatalog([])))
      .toEqual({ visibleIds: [LEGACY_INPUT], iconOrder: [LEGACY_INPUT, LEGACY_DRAWER] })
    expect(normalizeToolbarExtensionActions(beforeRegistration, OWNER_CATALOG))
      .toEqual({ visibleIds: [KEY_INPUT], iconOrder: [KEY_INPUT, KEY_DRAWER] })
  })
})

describe('coherent normalization', () => {
  test('deduplicates known aliases at their first order position', () => {
    expect(normalizeToolbarExtensionActions({
      visibleIds: [LEGACY_INPUT, 'profile', KEY_INPUT],
      iconOrder: [LEGACY_INPUT, KEY_DRAWER, 'profile', KEY_INPUT, LEGACY_DRAWER],
    }, OWNER_CATALOG)).toEqual({
      visibleIds: [KEY_INPUT, 'profile'],
      iconOrder: [KEY_INPUT, KEY_DRAWER, 'profile'],
    })
  })

  test('appends selected ids without a slot and preserves unknown ids', () => {
    expect(normalizeToolbarExtensionActions({
      visibleIds: ['profile', LEGACY_DRAWER],
      iconOrder: ['profile', 'command:something', 'unknown-string'],
    }, OWNER_CATALOG)).toEqual({
      visibleIds: ['profile', KEY_DRAWER],
      iconOrder: ['profile', 'command:something', 'unknown-string', KEY_DRAWER],
    })
  })

  test('imports composer hidden aliases with hidden winning', () => {
    expect(normalizeComposerExtensionActions({
      order: [LEGACY_INPUT, 'home', KEY_DRAWER],
      hidden: [KEY_INPUT, LEGACY_DRAWER],
    }, OWNER_CATALOG)).toEqual({
      order: [KEY_INPUT, 'home', KEY_DRAWER],
      hidden: [KEY_INPUT, KEY_DRAWER],
    })

    expect(normalizeComposerExtensionActions({ order: [LEGACY_INPUT], hidden: [LEGACY_INPUT] }, OWNER_CATALOG))
      .toEqual({ order: [KEY_INPUT], hidden: [KEY_INPUT] })
  })

  test('keeps a hidden-only composer action addressable at the tail', () => {
    expect(normalizeComposerExtensionActions({ order: ['home'], hidden: [LEGACY_DRAWER] }, OWNER_CATALOG))
      .toEqual({ order: ['home', KEY_DRAWER], hidden: [KEY_DRAWER] })
  })

  test('is idempotent and never mutates its inputs', () => {
    const toolbar = { visibleIds: [LEGACY_INPUT, 'profile'], iconOrder: [LEGACY_INPUT, KEY_INPUT, 'profile'] }
    const composer = { order: [LEGACY_DRAWER, 'home'], hidden: [KEY_DRAWER] }
    const toolbarSnapshot = { visibleIds: [...toolbar.visibleIds], iconOrder: [...toolbar.iconOrder] }
    const composerSnapshot = { order: [...composer.order], hidden: [...composer.hidden] }

    const normalizedToolbar = normalizeToolbarExtensionActions(toolbar, OWNER_CATALOG)
    const normalizedComposer = normalizeComposerExtensionActions(composer, OWNER_CATALOG)

    expect(toolbar).toEqual(toolbarSnapshot)
    expect(composer).toEqual(composerSnapshot)
    expect(normalizeToolbarExtensionActions(normalizedToolbar, OWNER_CATALOG)).toEqual(normalizedToolbar)
    expect(normalizeComposerExtensionActions(normalizedComposer, OWNER_CATALOG)).toEqual(normalizedComposer)
  })

  test('keeps the [] default sentinel instead of materializing defaults', () => {
    expect(normalizeToolbarExtensionActions({ visibleIds: [], iconOrder: [] }, OWNER_CATALOG))
      .toEqual({ visibleIds: [], iconOrder: [] })
    expect(normalizeComposerExtensionActions({ order: [], hidden: [] }, OWNER_CATALOG))
      .toEqual({ order: [], hidden: [] })
    expect(setToolbarExtensionActionVisible({ visibleIds: [], iconOrder: [] }, OWNER_CATALOG, KEY_INPUT, false))
      .toEqual({ visibleIds: [], iconOrder: [] })
    expect(setComposerExtensionActionVisible({ order: [], hidden: [] }, OWNER_CATALOG, KEY_INPUT, true))
      .toEqual({ order: [KEY_INPUT], hidden: [] })
  })

  test('leaves native and command keys untouched in both models', () => {
    expect(normalizeToolbarExtensionActions({
      visibleIds: ['profile', 'command:foo', 'settings:productivity'],
      iconOrder: ['settings:productivity', 'profile', 'command:foo'],
    }, OWNER_CATALOG)).toEqual({
      visibleIds: ['profile', 'command:foo', 'settings:productivity'],
      iconOrder: ['settings:productivity', 'profile', 'command:foo'],
    })

    expect(normalizeComposerExtensionActions({
      order: ['home', 'regen', 'connections'],
      hidden: ['connections'],
    }, OWNER_CATALOG)).toEqual({
      order: ['home', 'regen', 'connections'],
      hidden: ['connections'],
    })
  })

  test('never drops saved strings for unavailable actions', () => {
    const ghost = 'input-action:ghost:spindle:ghost:action:missing:3'

    expect(normalizeToolbarExtensionActions({
      visibleIds: [ghost, KEY_INPUT],
      iconOrder: [ghost, KEY_INPUT],
    }, OWNER_CATALOG)).toEqual({
      visibleIds: [ghost, KEY_INPUT],
      iconOrder: [ghost, KEY_INPUT],
    })
  })

  test('discards non-string entries read back from persisted JSON', () => {
    const raw = [KEY_INPUT, 42, null, { id: 'x' }] as unknown as string[]

    expect(normalizeComposerExtensionActions({ order: raw, hidden: [] }, OWNER_CATALOG))
      .toEqual({ order: [KEY_INPUT], hidden: [] })
    expect(normalizeToolbarExtensionActions({ visibleIds: raw, iconOrder: raw }, OWNER_CATALOG))
      .toEqual({ visibleIds: [KEY_INPUT], iconOrder: [KEY_INPUT] })
  })
})

describe('explicit show and hide', () => {
  test('toolbar hide removes every visible alias and keeps the order slot', () => {
    expect(setToolbarExtensionActionVisible({
      visibleIds: [LEGACY_INPUT, 'profile'],
      iconOrder: [LEGACY_INPUT, 'unknown', 'profile'],
    }, OWNER_CATALOG, KEY_INPUT, false)).toEqual({
      visibleIds: ['profile'],
      iconOrder: [KEY_INPUT, 'unknown', 'profile'],
    })
  })

  test('toolbar show adds one canonical slot and never duplicates', () => {
    expect(setToolbarExtensionActionVisible({
      visibleIds: ['profile'],
      iconOrder: ['profile'],
    }, OWNER_CATALOG, LEGACY_INPUT, true)).toEqual({
      visibleIds: ['profile', KEY_INPUT],
      iconOrder: ['profile', KEY_INPUT],
    })

    expect(setToolbarExtensionActionVisible({
      visibleIds: [LEGACY_INPUT],
      iconOrder: [],
    }, OWNER_CATALOG, KEY_INPUT, true)).toEqual({
      visibleIds: [KEY_INPUT],
      iconOrder: [KEY_INPUT],
    })
  })

  test('composer show removes every equivalent hidden alias', () => {
    expect(setComposerExtensionActionVisible({
      order: [KEY_INPUT, 'home'],
      hidden: [LEGACY_INPUT],
    }, OWNER_CATALOG, KEY_INPUT, true)).toEqual({
      order: [KEY_INPUT, 'home'],
      hidden: [],
    })
  })

  test('composer hide writes one canonical entry and is idempotent', () => {
    const hiddenOnce = setComposerExtensionActionVisible({
      order: [LEGACY_INPUT, 'home'],
      hidden: [],
    }, OWNER_CATALOG, KEY_INPUT, false)

    expect(hiddenOnce).toEqual({ order: [KEY_INPUT, 'home'], hidden: [KEY_INPUT] })
    expect(setComposerExtensionActionVisible(hiddenOnce, OWNER_CATALOG, LEGACY_INPUT, false)).toEqual(hiddenOnce)
  })

  test('composer hide materializes a missing order slot in the same edit', () => {
    const initial = { order: ['home'], hidden: [] }
    const hiddenOnce = setComposerExtensionActionVisible(initial, OWNER_CATALOG, KEY_INPUT, false)

    // The completed pair is already normalized, so repeating the same Hide and
    // the normalizer's own projection agree with the first result.
    expect(hiddenOnce).toEqual({ order: ['home', KEY_INPUT], hidden: [KEY_INPUT] })
    expect(normalizeComposerExtensionActions(hiddenOnce, OWNER_CATALOG)).toEqual(hiddenOnce)
    expect(setComposerExtensionActionVisible(hiddenOnce, OWNER_CATALOG, KEY_INPUT, false)).toEqual(hiddenOnce)
    // The legacy alias resolves to the same pair.
    expect(setComposerExtensionActionVisible(initial, OWNER_CATALOG, LEGACY_INPUT, false)).toEqual(hiddenOnce)
    // The input pair is never mutated.
    expect(initial).toEqual({ order: ['home'], hidden: [] })
    // A later Show clears the hidden intent and keeps the single order slot.
    expect(setComposerExtensionActionVisible(hiddenOnce, OWNER_CATALOG, KEY_INPUT, true))
      .toEqual({ order: ['home', KEY_INPUT], hidden: [] })
  })

  test('composer hide keeps an already-represented target untouched', () => {
    const initial = { order: ['home', KEY_INPUT], hidden: [KEY_INPUT] }

    expect(setComposerExtensionActionVisible(initial, OWNER_CATALOG, KEY_INPUT, false)).toEqual(initial)
  })

  test('a later Show is not undone by the hidden-wins import', () => {
    const imported = normalizeComposerExtensionActions({ order: [LEGACY_INPUT], hidden: [LEGACY_INPUT] }, OWNER_CATALOG)

    expect(imported).toEqual({ order: [KEY_INPUT], hidden: [KEY_INPUT] })
    expect(setComposerExtensionActionVisible(imported, OWNER_CATALOG, KEY_INPUT, true))
      .toEqual({ order: [KEY_INPUT], hidden: [] })
    expect(normalizeComposerExtensionActions({ order: [KEY_INPUT], hidden: [] }, OWNER_CATALOG))
      .toEqual({ order: [KEY_INPUT], hidden: [] })
  })
})

describe('complementary order preservation', () => {
  test('reverses the available slots and leaves absent/hidden slots in place', () => {
    expect(mergeExtensionActionOrder(['a', 'u', 'h', 'v', 'b'], ['a', 'b'], ['b', 'a']))
      .toEqual(['b', 'u', 'h', 'v', 'a'])
  })

  test('rejects a stale permutation without dropping newly added ids', () => {
    expect(mergeExtensionActionOrder(['a', 'u', 'b'], ['a', 'b', 'c'], ['b', 'a']))
      .toEqual(['a', 'u', 'b'])
    expect(mergeExtensionActionOrder(['a', 'n', 'u', 'b'], ['a', 'b'], ['b', 'a']))
      .toEqual(['b', 'n', 'u', 'a'])
    expect(mergeExtensionActionOrder(['a', 'u', 'b'], ['a', 'b'], ['a', 'b', 'c']))
      .toEqual(['a', 'u', 'b'])
    // A duplicated snapshot is rejected the same way a stale one is.
    expect(mergeExtensionActionOrder(['a', 'u', 'b'], ['a', 'a', 'b'], ['a', 'a', 'b']))
      .toEqual(['a', 'u', 'b'])
  })

  test('does not mutate the order it was given', () => {
    const fullOrder = ['a', 'u', 'b']
    const available = ['a', 'b']

    expect(mergeExtensionActionOrder(fullOrder, available, ['b', 'a'])).toEqual(['b', 'u', 'a'])
    expect(fullOrder).toEqual(['a', 'u', 'b'])
    expect(available).toEqual(['a', 'b'])
  })

  test('pin moves the target to the first available slot only', () => {
    expect(pinExtensionActionToFirstSlot(['a', 'u', 'h', 'v', 'b'], ['a', 'b'], 'b'))
      .toEqual(['b', 'u', 'h', 'v', 'a'])
    expect(pinExtensionActionToFirstSlot(['a', 'u', 'h', 'v', 'b'], ['a', 'b'], 'h'))
      .toEqual(['a', 'u', 'h', 'v', 'b'])
  })

  test('isExtensionActionOrderPermutation compares membership', () => {
    expect(isExtensionActionOrderPermutation(['b', 'a'], ['a', 'b'])).toBe(true)
    expect(isExtensionActionOrderPermutation([], [])).toBe(true)
    expect(isExtensionActionOrderPermutation(['b', 'a'], ['a', 'b', 'c'])).toBe(false)
    expect(isExtensionActionOrderPermutation(['b', 'a'], ['a', 'c'])).toBe(false)
  })

  test('isExtensionActionOrderPermutation rejects duplicated ids on either side', () => {
    // Equal length and equal membership are not enough: a duplicated id means
    // this is not the unique permutation the order contract requires.
    expect(isExtensionActionOrderPermutation(['a', 'a', 'b'], ['a', 'b', 'a'])).toBe(false)
    expect(isExtensionActionOrderPermutation(['a', 'b', 'a'], ['a', 'a', 'b'])).toBe(false)
    // Only the current side is duplicated.
    expect(isExtensionActionOrderPermutation(['a', 'b', 'c'], ['a', 'a', 'b'])).toBe(false)
    // Only the next side is duplicated.
    expect(isExtensionActionOrderPermutation(['a', 'a', 'b'], ['a', 'b', 'c'])).toBe(false)
    expect(isExtensionActionOrderPermutation(['a', 'a'], ['a', 'a'])).toBe(false)
  })

  test('applyComposerExtensionActionOrder applies a live permutation and rejects a stale one', () => {
    expect(applyComposerExtensionActionOrder({ order: [KEY_INPUT, 'home'], hidden: [] }, OWNER_CATALOG, ['home', KEY_INPUT]))
      .toEqual({ order: ['home', KEY_INPUT], hidden: [] })
    expect(applyComposerExtensionActionOrder(
      { order: [KEY_INPUT, 'home', 'newcomer'], hidden: [] },
      OWNER_CATALOG,
      ['home', KEY_INPUT],
    )).toEqual({ order: [KEY_INPUT, 'home', 'newcomer'], hidden: [] })
  })
})
