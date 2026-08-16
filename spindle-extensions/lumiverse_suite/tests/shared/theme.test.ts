import { describe, expect, test } from 'bun:test'

import { installThemeBridge, THEME_BRIDGE_CSS } from '../../src/shared/theme'

interface ThemeStyle {
  css: string
  removed: boolean
}

function createAddStyle(styles: ThemeStyle[]) {
  return (css: string) => {
    const style: ThemeStyle = { css, removed: false }
    styles.push(style)
    return () => {
      style.removed = true
      const index = styles.indexOf(style)
      if (index !== -1) styles.splice(index, 1)
    }
  }
}

describe('theme bridge', () => {
  test('installs no visible UI and removes its lifecycle-owned style after disposal', () => {
    const styles: ThemeStyle[] = []
    const dispose = installThemeBridge(createAddStyle(styles), {})

    expect(styles).toHaveLength(1)
    expect(styles[0]?.css).toBe(THEME_BRIDGE_CSS)

    dispose()
    dispose()

    expect(styles).toHaveLength(0)
  })

  test('shares one inert bridge across owners until the final disposal', () => {
    const styles: ThemeStyle[] = []
    const owner = {}
    const addStyle = createAddStyle(styles)
    const firstDispose = installThemeBridge(addStyle, owner)
    const secondDispose = installThemeBridge(addStyle, owner)

    expect(styles).toHaveLength(1)

    firstDispose()
    expect(styles).toHaveLength(1)

    secondDispose()
    expect(styles).toHaveLength(0)
  })

  test.each([
    [
      'light',
      {
        '--lumiverse-bg': '#fbf8ff',
        '--lumiverse-primary': '#6750a4',
      },
    ],
    [
      'dark',
      {
        '--lumiverse-bg': '#1c1826',
        '--lumiverse-primary': '#9370db',
      },
    ],
  ])('bridges %s host tokens without rewriting host tokens', (_theme, hostTokens) => {
    const styles: ThemeStyle[] = []
    const dispose = installThemeBridge(createAddStyle(styles), {})
    const bridge = styles[0]

    expect(hostTokens['--lumiverse-bg']).toBe(hostTokens['--lumiverse-bg'])
    expect(bridge?.css).toContain(
      '--lumiverse-suite-surface: var(--lumiverse-bg, #1c1826);',
    )
    expect(bridge?.css).toContain(
      '--lumiverse-suite-surface-elevated: var(--lumiverse-bg-elevated, #231e30);',
    )
    expect(bridge?.css).toContain(
      '--lumiverse-suite-text: var(--lumiverse-text, rgba(255, 255, 255, 0.9));',
    )
    expect(bridge?.css).toContain(
      '--lumiverse-suite-accent: var(--lumiverse-primary, #9370db);',
    )

    dispose()
  })
})
