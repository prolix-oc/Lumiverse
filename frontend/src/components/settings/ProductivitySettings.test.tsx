import { describe, expect, mock, test } from 'bun:test'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'

import { PRODUCTIVITY_DEFAULTS } from '@/lib/uiProductivityDefaults'
import { bindProductivitySetting } from './ProductivitySettingsModel'

const state = {
  ...PRODUCTIVITY_DEFAULTS,
  quickToolbarSettings: {
    ...PRODUCTIVITY_DEFAULTS.quickToolbarSettings,
    variant: 'v2-settings-adjacent',
  },
  connectionsPickerSettings: {
    ...PRODUCTIVITY_DEFAULTS.connectionsPickerSettings,
    profileTags: [{ id: 'tag-1', name: 'Primary', color: '#64748B', order: 0 }],
    visibleTagIds: ['tag-1'],
  },
  loreIndicatorSettings: {
    ...PRODUCTIVITY_DEFAULTS.loreIndicatorSettings,
    variant: 'v4-bottom-strip',
  },
  profiles: [],
  updateProfile: () => undefined,
}

const useStore = Object.assign(
  (selector: (value: typeof state) => unknown) => selector(state),
  {
    getState: () => state,
    setState: (partial: Record<string, unknown>) => Object.assign(state, partial),
  },
)

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test/' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  navigator: dom.window.navigator,
  Event: dom.window.Event,
})
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

mock.module('@/store', () => ({ useStore }))
mock.module('@/components/quick-toolbar/useQuickToolbarActions', () => ({
  DESIGN_DEFAULT_IDS: ['profile', 'connections', 'lorebook', 'settings'],
  useQuickToolbarActions: () => ({
    actionById: new Map([
      ['profile', { label: 'Profile' }],
      ['connections', { label: 'Connections' }],
      ['lorebook', { label: 'Lorebook' }],
      ['settings', { label: 'Settings' }],
    ]),
    visibleIds: ['profile', 'connections', 'lorebook', 'settings'],
    orderedIds: ['profile', 'connections', 'lorebook', 'settings'],
    reorderActions: () => undefined,
    toggleAction: () => undefined,
  }),
}))
mock.module('@/lib/toolbarActionSearch', () => ({
  canMoveWithinFiltered: () => false,
  filterActionIds: (ids: string[]) => ids,
  moveWithinFiltered: (ids: string[]) => ids,
}))
mock.module('@/api/connections', () => ({ connectionsApi: { update: () => Promise.resolve() } }))
mock.module('@/lib/connectionsPicker', () => ({ getConnectionProfileTagIds: () => [] }))
mock.module('@/lib/avatarUrls', () => ({
  getCharacterAvatarLargeUrlById: (characterId: string, imageId?: string) => `/api/v1/images/${imageId ?? characterId}?size=lg`,
}))
const persistedKeys: Array<{ key: string; value: unknown }> = []
mock.module('@/store/slices/settings', () => ({
  persistKey: (key: string, value: unknown) => persistedKeys.push({ key, value }),
}))

const { default: ProductivitySettings } = await import('./ProductivitySettings')

describe('canonical Productivity settings renderer', () => {
  test('renders the approved variant controls and V2 scale guard', () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)

    expect(markup).toContain('V2 Adjacent')
    expect(markup).toContain('V2 never scales - it is anchored in the chat dock.')
    expect(markup).toContain('A Tags')
    expect(markup).toContain('B Split')
    expect(markup).toContain('C Full')
    expect(markup).toContain('Card density')
    expect(markup).not.toContain('Vertical orientation')
    expect(markup).toContain('V4 Strip')
    expect(markup).toContain('V5 Palette')
    expect(markup).not.toContain('#7C3AED')
  })

  test('keeps V1 to the source toolbar controls without manual rectangle fields', () => {
    const previous = state.quickToolbarSettings
    state.quickToolbarSettings = {
      ...PRODUCTIVITY_DEFAULTS.quickToolbarSettings,
      variant: 'v1-free',
    }

    const markup = renderToStaticMarkup(<ProductivitySettings />)
    state.quickToolbarSettings = previous

    expect(markup).toContain('Vertical orientation')
    expect(markup).toContain('Restore tab over full-screen dialogs')
    expect(markup).toContain('brings it back without closing the dialog')
    expect(markup).toContain('Hide when overlaid')
    expect(markup).toContain('When unset, this follows the mobile default.')
    expect(markup).not.toContain('Toolbar x')
    expect(markup).not.toContain('Toolbar y')
    expect(markup).not.toContain('Toolbar width')
    expect(markup).not.toContain('Toolbar height')
  })

  test('exposes fill, native select-messages, and opaque backdrop; hide-in-dock is gone', () => {
    const previous = state.quickToolbarSettings
    state.quickToolbarSettings = {
      ...PRODUCTIVITY_DEFAULTS.quickToolbarSettings,
      quickToolbarPlacement: 'floating',
    }
    const floating = renderToStaticMarkup(<ProductivitySettings />)
    expect(floating).not.toContain('Hide toolbar in chat top bar')
    expect(floating).not.toContain('quick-hide-in-chat-top-dock')
    expect(floating).not.toContain('Fill chat top bar width')
    expect(floating).toContain('Fill the entire top of the screen')
    expect(floating).toContain('quick-fill-top-dock-width')
    expect(floating).toContain('Show select-messages on chat top bar')
    expect(floating).toContain('quick-show-native-select-messages')
    expect(floating).toContain('Opaque toolbar backdrop')
    expect(floating).toContain('quick-opaque-toolbar-backdrop')

    state.quickToolbarSettings = {
      ...PRODUCTIVITY_DEFAULTS.quickToolbarSettings,
      quickToolbarPlacement: 'chat_top_dock',
    }
    const docked = renderToStaticMarkup(<ProductivitySettings />)
    state.quickToolbarSettings = previous

    expect(docked).not.toContain('Hide toolbar in chat top bar')
    expect(docked).not.toContain('quick-hide-in-chat-top-dock')
    expect(docked).toContain('Fill chat top bar width')
    expect(docked).toContain('quick-fill-top-dock-width')
    expect(docked).toContain('quick-show-native-select-messages')
    expect(docked).toContain('quick-opaque-toolbar-backdrop')
  })

  test('exposes overlay hide and restore on V2 Adjacent floating', () => {
    const previous = state.quickToolbarSettings
    state.quickToolbarSettings = {
      ...PRODUCTIVITY_DEFAULTS.quickToolbarSettings,
      variant: 'v2-settings-adjacent',
    }

    const markup = renderToStaticMarkup(<ProductivitySettings />)
    state.quickToolbarSettings = previous

    expect(markup).toContain('Hide when overlaid')
    expect(markup).toContain('Restore tab over full-screen dialogs')
    expect(markup).toContain('quick-v2-hide-when-overlaid')
    expect(markup).toContain('quick-v2-modal-restore')
    expect(markup).not.toContain('Vertical orientation')
  })

  test('renders Lore Indicator launch-target controls', () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)
    expect(markup).toContain('Click launch target')
    expect(markup).toContain('Native drawer')
    expect(markup).toContain('Half screen')
    expect(markup).toContain('Full workspace')
  })

  test('renders dense card headers without decorative preview blocks', () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)

    expect(markup).toContain('Choose a confirmed variant and persist its layout.')
    expect(markup).toContain('Configure launcher, layouts, model metadata, and profile tags.')
    expect(markup).toContain('Configure compact, bottom-strip, and command-palette lore activity views.')
    expect(markup).toContain('Control homepage cards, filters, view defaults, and selected-character panel.')
    expect(markup).toContain('id="homepage-character-library-settings"')
    expect(markup).toContain('Configure opening behavior, persistent layout, dock state, and hover controls.')
    expect(markup).toContain('Configure full-page and half-screen launch behavior, pane sizes, and entry density.')
    expect(markup).not.toContain('Quick Toolbar preview')
    expect(markup).not.toContain('Connections Picker preview')
    expect(markup).not.toContain('UI Productivity')
    expect(markup).toContain('Reset all toolbar settings')
    expect(markup).toContain('Reset all picker settings')
    expect(markup).toContain('Reset all Lore Indicator settings')
    expect(markup).toContain('Reset all homepage library settings')
    expect(markup).toContain('Reset homepage layout')
    expect(markup).toContain('Reset Character Tab layout')
    expect(markup).toContain('Reset all Portrait Dock settings')
    expect(markup).toContain('Reset all Lorebook Editor settings')
    expect(markup).toContain('Reset current variant')
    expect(markup).toContain('Reset current portrait layout')
    expect(markup).toContain('Reset current editor layout')
    expect(markup).toContain('Default dock side')
    expect(markup).toContain('Current dock side')
    expect(markup).toContain('Last portrait: No saved portrait')
    expect(markup).not.toContain('Half-screen height')
    expect(markup).toContain('Last selected character')
    expect(markup).not.toContain('Visible tag bindings')
    expect(markup).not.toContain('Favourite profile bindings')
    expect(markup).not.toContain('Recent profile bindings')
    expect(markup).not.toContain('Half entries pane width')
    expect((markup.match(/data-productivity-card-header-action/g) ?? []).length).toBe(6)
    expect(markup).toContain('aria-label="Enable Quick Toolbar"')
    expect(markup).toContain('aria-label="Enable Connections Picker"')
    expect(markup).toContain('aria-label="Enable Lore Indicator"')
    expect(markup).toContain('aria-label="Enable homepage library"')
    expect(markup).toContain('aria-label="Use homepage character display settings"')
    expect(markup).toContain('aria-label="Enable portrait dock"')
    expect(markup).not.toContain('id="lore-sticky-icon"')
  })

  test('uses source ranges and segmented display controls for homepage and Character Tab', () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)

    expect(markup).toContain('id="home-thumbnail-width" type="range" min="100" max="360"')
    expect(markup).toContain('id="home-thumbnail-height" type="range" min="120" max="520"')
    expect(markup).toContain('id="home-max-tags" type="range" min="1" max="20"')
    expect(markup).toContain('Compact glass')
    expect(markup).toContain('Visible metadata')
    expect(markup).not.toContain('id="home-metadata"')
    expect(markup).not.toContain('id="character-metadata"')
  })

  test('locks the responsive Quick Toolbar, Character Tab, and Lorebook layout contracts', async () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)
    const css = await Bun.file(resolve(import.meta.dir, 'ProductivitySettings.module.css')).text()

    expect(markup).toContain('data-productivity-layout="quick-toolbar-controls"')
    expect((markup.match(/data-productivity-layout="quick-toolbar-slider-pair"/g) ?? []).length).toBe(2)
    expect(markup).toMatch(/id="quick-scale"[^>]*disabled=""/)
    expect(markup).toContain('data-productivity-layout="character-thumbnail-pair"')
    expect(markup).toContain('data-lorebook-section="segments"')
    expect(markup).toContain('data-lorebook-section="features"')
    expect(markup).toContain('data-lorebook-section="half-layout"')
    expect(markup).toContain('data-lorebook-section="pane-sizes"')
    expect(markup).toContain('data-lorebook-section="counting"')
    expect(markup).toContain('data-lorebook-section="metadata"')
    expect(markup).toContain('data-lorebook-section="resets"')
    expect(css).toContain('width: 100%')
    expect(css).toContain('.panel {')
    expect(css).toContain('box-sizing: border-box')
    expect(css).toContain('.quickToolbarControls')
    expect(css).toContain('.quickToolbarSliderPair')
    expect(css).toContain('.quickToolbarCheck label { gap: 6px; }')
    expect(css).toContain('white-space: nowrap')
    expect(css).toContain('.characterThumbnailPair')
    expect(css).toContain('.lorebookPaneRow')
    expect(css).toContain('.lorebookCountingChecks')
    expect(css).toContain('@container (max-width: 560px)')
  })

  test('keeps the source homepage live card and selected-character panel preview', async () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)
    const css = await Bun.file(resolve(import.meta.dir, 'ProductivitySettings.module.css')).text()

    expect(markup).toContain('aria-label="Homepage character card live preview"')
    expect(markup).toContain('>Live preview<')
    expect(markup).toContain('>C<')
    expect(markup).toContain('Pinned preview')
    expect(markup).toContain('data-density="compact"')
    expect(css).toContain('.homepagePreviewPlaceholder')
    expect(css).toContain('.homepagePreviewCard[data-footer-mode=\'compact\']')
    expect(css).toContain('.homepagePreviewPanelImage')
    expect(css).toContain('@media (max-width: 720px)')
  })

  test('uses the selected character avatar and metadata in the homepage preview', () => {
    const previousCharacters = (state as any).characters
    ;(state as any).characters = [{ id: 'character-1', name: 'Iris', image_id: 'image-1', creator: 'Author', tags: ['Mystic', 'Strategist', 'Empath'] }]
    state.homepageCharacterLibrarySettings = {
      ...PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings,
      lastSelectedCharacterId: 'character-1',
      maxVisibleTags: 2,
      visibleMetadata: ['creator', 'tags'],
    }

    const markup = renderToStaticMarkup(<ProductivitySettings />)
    ;(state as any).characters = previousCharacters
    state.homepageCharacterLibrarySettings = PRODUCTIVITY_DEFAULTS.homepageCharacterLibrarySettings

    expect(markup).toContain('Iris')
    expect(markup).toContain('Author')
    expect(markup).toContain('Mystic')
    expect(markup).toContain('+1')
    expect(markup).toContain('/api/v1/images/image-1?size=lg')
    expect(markup).toContain('data-pinned="true"')
  })

  test('uses source Connections bounds and protects all-entry counts without a tokenizer', () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)

    expect(markup).toContain('id="connections-launcher-size" type="range" min="14" max="32"')
    expect(markup).toContain('id="connections-thumbnail-size" type="range" min="20" max="56"')
    expect(markup).toContain('id="connections-opacity" type="range" min="30" max="100" step="1"')
    expect(markup).toContain('id="connections-section-spacing" type="range" min="4" max="28"')
    expect(markup).toContain('id="connections-profile-column" type="range" min="140" max="420"')
    expect(markup).toContain('id="connections-model-column" type="range" min="180" max="520"')
    expect(markup).toContain('Half-screen width')
    expect(markup).toContain('Protected chat width')
    expect(markup).toContain('Counting every entry needs a connection profile with a model selected')
    expect(markup).toMatch(/id="lorebook-count-all"[^>]*disabled=""/)
  })

  test('exposes segmented selection and accessible checkbox and select names', () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)

    expect((markup.match(/role="group" aria-label="[^"]+"/g) ?? []).length).toBeGreaterThan(5)
    expect(markup).toContain('aria-pressed="true"')
    const checkboxes = markup.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []
    expect(checkboxes.length).toBeGreaterThan(0)
    expect(checkboxes.every((tag) => /aria-label="[^"]+"/.test(tag))).toBe(true)
    expect((markup.match(/type="range"/g) ?? []).length).toBeGreaterThan(10)
    expect((markup.match(/type="number"/g) ?? []).length).toBeGreaterThan(10)
    expect(markup).toContain('aria-label="Icon size exact value"')
    expect(markup).toContain('aria-label="Menu width exact value"')
    const selects = markup.match(/<select[^>]*>/g) ?? []
    expect(selects.length).toBeGreaterThan(0)
    expect(selects.every((tag) => /aria-label="[^"]+"/.test(tag))).toBe(true)
  })

  test('uses source toolbar labels, icon actions, and host theme primitives', async () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)
    const css = await Bun.file(resolve(import.meta.dir, 'ProductivitySettings.module.css')).text()

    expect(markup).toContain('>Profile<')
    expect(markup).toContain('aria-label="Move Profile up"')
    expect(markup).toContain('aria-label="Move Profile down"')
    expect(markup).toContain('Search icons...')
    expect(markup).toContain('Reset all toolbar settings')
    expect(markup).toContain('Show chat launcher')
    expect(markup).toContain('Clear')
    expect(markup).toContain('Visible entry metadata')
    expect(markup).toContain('Count tokens')
    expect(markup).toContain('Count ahead when hovering an entry')
    expect(markup).toContain('Active-entry count')
    expect(markup).toContain('aria-label="Remove Active-entry count"')
    expect(css).toContain('var(--lumiverse-primary)')
    expect(css).toContain('border-radius: 12px')
    expect(css).toContain('grid-template-columns: 18px minmax(0, 1fr) 28px 28px')
    expect(css).toContain('.productivityRowMuted')
    expect(css).toContain('.disabledSettingsGroup')
    expect(css).toContain('.runtimeStateRow')
    expect(css).not.toContain('--productivity-')
  })

  test('keeps V2 toolbar slider cells symmetric and moves its helper below the pair', async () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)
    const css = await Bun.file(resolve(import.meta.dir, 'ProductivitySettings.module.css')).text()
    const secondPairStart = markup.indexOf('data-productivity-layout="quick-toolbar-slider-pair"', markup.indexOf('data-productivity-layout="quick-toolbar-slider-pair"') + 1)
    const hintIndex = markup.indexOf('id="quick-scale-v2-hint"')

    expect(secondPairStart).toBeGreaterThan(-1)
    expect(hintIndex).toBeGreaterThan(secondPairStart)
    expect(markup).toContain('aria-describedby="quick-scale-v2-hint"')
    expect((markup.match(/id="quick-scale-v2-hint"/g) ?? []).length).toBe(1)
    expect(css).toContain('.quickToolbarPairHint')
    expect(css).toContain('grid-column: 1 / -1')
    expect(css).toContain('.preciseValue')
  })

  test('wires precise Quick Toolbar editors through the shared canonical number callback', async () => {
    const markup = renderToStaticMarkup(<ProductivitySettings />)
    const source = await Bun.file(resolve(import.meta.dir, 'ProductivitySettings.tsx')).text()

    expect(markup).toContain('id="quick-icon-size-value" type="number"')
    expect(markup).toContain('id="quick-label-size-value" type="number"')
    expect(markup).toMatch(/id="quick-scale-value"[^>]*disabled=""/)
    expect(markup).toContain('aria-label="Opacity exact value"')
    expect(source).toContain('if (next !== safeValue) onChange(next)')
    expect(source).toContain('<PreciseValueInput id={id}')
  })

  test('keeps Character Tab values when its homepage inheritance checkbox is changed', async () => {
    const previousCharacter = state.characterTabDisplaySettings
    state.characterTabDisplaySettings = {
      ...PRODUCTIVITY_DEFAULTS.characterTabDisplaySettings,
      useHomepageSettings: false,
      thumbnailWidth: 157,
      thumbnailHeight: 172,
      visibleMetadata: ['tags', 'lorebooks'],
    }
    persistedKeys.length = 0
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => { root.render(<ProductivitySettings />); await Promise.resolve() })

    const checkbox = host.querySelector<HTMLInputElement>('#character-home-settings')
    expect(checkbox).toBeTruthy()
    await act(async () => { checkbox?.click(); await Promise.resolve() })

    expect(state.characterTabDisplaySettings).toMatchObject({
      useHomepageSettings: true,
      thumbnailWidth: 157,
      thumbnailHeight: 172,
      visibleMetadata: ['tags', 'lorebooks'],
    })
    expect(persistedKeys.at(-1)).toMatchObject({ key: 'characterTabDisplaySettings' })

    await act(async () => { root.unmount(); await Promise.resolve() })
    host.remove()
    state.characterTabDisplaySettings = previousCharacter
  })

  test('preserves every saved Lorebook rectangle dimension when one field is patched', async () => {
    const saved = { ...PRODUCTIVITY_DEFAULTS.lorebookEditorSettings, halfRect: { x: 43, y: 57, width: 720, height: 630 } }
    const next = bindProductivitySetting(saved, { halfRect: { ...saved.halfRect, width: 907 } })
    const source = await Bun.file(resolve(import.meta.dir, 'ProductivitySettings.tsx')).text()

    expect(next.halfRect).toEqual({ x: 43, y: 57, width: 907, height: 630 })
    expect(source).toContain('halfRect: { ...lorebook.halfRect, width }')
    expect(source).toContain('halfRect: { ...lorebook.halfRect, height }')
    expect(source).toContain('halfRect: { ...lorebook.halfRect, x }')
    expect(source).toContain('halfRect: { ...lorebook.halfRect, y }')
  })

  test('dispatches a real click from the Activation segmented control', async () => {
    const previousLore = state.loreIndicatorSettings
    state.loreIndicatorSettings = {
      ...PRODUCTIVITY_DEFAULTS.loreIndicatorSettings,
      variant: 'v2-compact',
      v2ActivationMode: 'click',
    }
    persistedKeys.length = 0
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<ProductivitySettings />)
      await Promise.resolve()
    })

    const hover = host.querySelector<HTMLButtonElement>('[role="group"][aria-label="Activation"] button[aria-pressed="false"]')
    expect(hover).toBeTruthy()
    await act(async () => {
      hover?.click()
      await Promise.resolve()
    })
    expect(state.loreIndicatorSettings.v2ActivationMode).toBe('hover')
    expect(persistedKeys.at(-1)).toMatchObject({ key: 'loreIndicatorSettings' })

    await act(async () => {
      root.unmount()
      await Promise.resolve()
    })
    host.remove()
    state.loreIndicatorSettings = previousLore
  })
})
