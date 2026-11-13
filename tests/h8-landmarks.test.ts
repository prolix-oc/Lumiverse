import { describe, expect, test } from 'bun:test'

const landingPageSource = await Bun.file(new URL('../frontend/src/components/landing/LandingPage.tsx', import.meta.url)).text()
const connectionItemSource = await Bun.file(new URL('../frontend/src/components/panels/connection-manager/ConnectionItem.tsx', import.meta.url)).text()

describe('P8 H8 landmark contract', () => {
  test('LandingPage exposes exactly the five surviving inner regions and no footer', () => {
    const regions = [...landingPageSource.matchAll(/data-component="(LandingPage(?:Header|Main|Tabs|Characters|Chats))"/g)]
      .map((match) => match[1])
    expect(regions.sort()).toEqual([
      'LandingPageCharacters',
      'LandingPageChats',
      'LandingPageHeader',
      'LandingPageMain',
      'LandingPageTabs',
    ])
    expect(landingPageSource).not.toContain('LandingPageFooter')
  })

  test('ConnectionItem marks both the editing and display roots', () => {
    expect(connectionItemSource.match(/data-component="ConnectionItem"/g)?.length).toBe(2)
  })
})
