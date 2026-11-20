import { DATA_KEYS } from '@/store/slices/settings'

/**
 * Audited, read-only host settings exposed through ctx.settings.core.
 *
 * This is the sole persisted-setting allowlist. Adding a DATA_KEYS entry does
 * not expose it to extensions unless it is explicitly added here.
 */
export interface CoreSettingKey {
  readonly key: string
  readonly source: string
  readonly permission: string | null
  readonly note: string
  readonly writable: false
}

export type SettingsAuthoritySurface = 'state_selector' | 'ctx_member'

export interface SettingsAuthorityRow {
  readonly surface: SettingsAuthoritySurface
  readonly id: string
  readonly source: string
  readonly permission: string | null
  readonly freeBecause: string
  readonly ctxLeaf?: string
}

const CORE_SETTING_READ_BASIS =
  'rest: GET /api/v1/settings/<key> is session-authenticated and returns the existing preference'
const OWN_NAMESPACE_WRITE_BASIS =
  'write-limb-i: the host composes spindle:<identifier>: from the manifest identifier; extensions cannot address another namespace'

const coreSetting = (key: string, note: string): CoreSettingKey => Object.freeze({
  key,
  source: `settings.${key}`,
  permission: null,
  note,
  writable: false as const,
})

/** The sole allowlist for audited core-setting reads. */
export const CORE_SETTING_KEYS: readonly CoreSettingKey[] = Object.freeze([
  coreSetting('favorites', 'Existing character-browser preference; read-only.'),
  coreSetting('worldBookEntryViewPrefs', 'Existing world-book entry view preference; read-only.'),
  coreSetting('theme', 'Existing theme preference; read-only.'),
  coreSetting('chatWidthMode', 'Existing chat layout preference; read-only.'),
  coreSetting('chatContentMaxWidth', 'Existing chat content-width preference; read-only.'),
  coreSetting('portraitPanelSide', 'Existing portrait placement preference; read-only.'),
  coreSetting('portraitDockSettings', 'Host-owned portrait dock placement and geometry preference; read-only.'),
  coreSetting('quickToolbarSettings', 'Host-owned quick toolbar preference; read-only.'),
  coreSetting('connectionsPickerSettings', 'Host-owned connections picker preference; read-only.'),
  coreSetting('loreIndicatorSettings', 'Host-owned lore indicator preference; read-only.'),
  coreSetting('homepageCharacterLibrarySettings', 'Host-owned homepage character library preference; read-only.'),
  coreSetting('characterTabDisplaySettings', 'Host-owned character tab display preference; read-only.'),
  coreSetting('lorebookEditorSettings', 'Host-owned lorebook editor preference; read-only.'),
  coreSetting('landingPageLayoutMode', 'Existing landing-page layout preference; read-only.'),
  coreSetting('charactersPerPage', 'Existing character-browser page-size preference; read-only.'),
].map((entry) => Object.freeze(entry)))

for (const entry of CORE_SETTING_KEYS) {
  if (!DATA_KEYS.has(entry.key)) {
    throw new Error(`CORE_SETTING_NOT_PERSISTED:${entry.key}`)
  }
}

/** Productivity blobs are canonical core settings; this remains for compatibility. */
export const SUITE_PREFERENCE_HOST_KEYS: Readonly<Record<string, true>> = Object.freeze({})

export function coreSettingKeysExcludeSuitePreferences(): boolean {
  return CORE_SETTING_KEYS.every((entry) =>
    SUITE_PREFERENCE_HOST_KEYS[entry.key] !== true
    && !entry.key.startsWith('spindle:lumiverse_suite:')
    && !entry.key.includes('lumiverse_suite'),
  )
}

export function getCoreSettingKey(key: string): CoreSettingKey | undefined {
  return CORE_SETTING_KEYS.find((entry) => entry.key === key)
}

/**
 * Projects the single allowlist into the shared authority map. The per-key
 * rows retain the source join used by state selectors; ctxLeaf projects the
 * dynamic runtime methods onto their exact callable paths.
 */
export function settingsAuthorityRows(): readonly SettingsAuthorityRow[] {
  const coreRows = CORE_SETTING_KEYS.flatMap<SettingsAuthorityRow>((entry) => [
    {
      surface: 'state_selector',
      id: `setting:${entry.key}`,
      source: entry.source,
      permission: entry.permission,
      freeBecause: CORE_SETTING_READ_BASIS.replace('<key>', entry.key),
    },
    {
      surface: 'ctx_member',
      id: `ctx.settings.core.get:${entry.key}`,
      source: entry.source,
      permission: entry.permission,
      freeBecause: CORE_SETTING_READ_BASIS.replace('<key>', entry.key),
      ctxLeaf: 'ctx.settings.core.get',
    },
    {
      surface: 'ctx_member',
      id: `ctx.settings.core.watch:${entry.key}`,
      source: entry.source,
      permission: entry.permission,
      freeBecause: CORE_SETTING_READ_BASIS.replace('<key>', entry.key),
      ctxLeaf: 'ctx.settings.core.watch',
    },
  ])

  return Object.freeze([
    ...coreRows,
    {
      surface: 'ctx_member',
      id: 'ctx.settings.core.list',
      source: 'settings.core.list',
      permission: null,
      freeBecause: 'rest: returns only the explicitly audited core settings from the authenticated session',
      ctxLeaf: 'ctx.settings.core.list',
    },
    {
      surface: 'ctx_member',
      id: 'ctx.settings.get',
      source: 'settings.spindle_namespace_own',
      permission: null,
      freeBecause: OWN_NAMESPACE_WRITE_BASIS,
      ctxLeaf: 'ctx.settings.get',
    },
    {
      surface: 'ctx_member',
      id: 'ctx.settings.set',
      source: 'settings.spindle_namespace_own',
      permission: null,
      freeBecause: OWN_NAMESPACE_WRITE_BASIS,
      ctxLeaf: 'ctx.settings.set',
    },
    {
      surface: 'ctx_member',
      id: 'ctx.settings.remove',
      source: 'settings.spindle_namespace_own',
      permission: null,
      freeBecause: OWN_NAMESPACE_WRITE_BASIS,
      ctxLeaf: 'ctx.settings.remove',
    },
    {
      surface: 'ctx_member',
      id: 'ctx.settings.watch',
      source: 'settings.spindle_namespace_own',
      permission: null,
      freeBecause: OWN_NAMESPACE_WRITE_BASIS,
      ctxLeaf: 'ctx.settings.watch',
    },
  ])
}
