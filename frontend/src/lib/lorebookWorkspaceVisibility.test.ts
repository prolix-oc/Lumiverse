import { afterEach, describe, expect, test } from 'bun:test'
import {
  getLorebookWorkspaceOverlayOpen,
  setLorebookWorkspaceVisibility,
} from './lorebookWorkspaceVisibility'

const hostSource = await Bun.file(new URL('./spindle/productivity-host-contracts.tsx', import.meta.url)).text()
const toolbarSource = await Bun.file(new URL('../components/quick-toolbar/QuickToolbar.tsx', import.meta.url)).text()

afterEach(() => {
  setLorebookWorkspaceVisibility('half', false)
  setLorebookWorkspaceVisibility('enhanced', false)
})

describe('extension lorebook workspace visibility', () => {
  test('stays open until both editor surfaces are closed', () => {
    setLorebookWorkspaceVisibility('half', true)
    expect(getLorebookWorkspaceOverlayOpen()).toBe(true)

    setLorebookWorkspaceVisibility('enhanced', true)
    setLorebookWorkspaceVisibility('half', false)
    expect(getLorebookWorkspaceOverlayOpen()).toBe(true)

    setLorebookWorkspaceVisibility('enhanced', false)
    expect(getLorebookWorkspaceOverlayOpen()).toBe(false)
  })

  test('connects extension host visibility to the toolbar subscriber', () => {
    expect(hostSource).toContain('setLorebookWorkspaceVisibility(visibilitySurface, state.open)')
    expect(toolbarSource).toContain('useLorebookWorkspaceOverlayOpen()')
  })
})
