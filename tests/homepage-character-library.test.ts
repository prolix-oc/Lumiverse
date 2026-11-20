import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const componentPath = new URL('../frontend/src/components/landing/HomepageCharacterLibrary.tsx', import.meta.url)
const stylesheetPath = new URL('../frontend/src/components/landing/HomepageCharacterLibrary.module.css', import.meta.url)
const hookPath = new URL('../frontend/src/hooks/useHomepageCharacterLibrary.ts', import.meta.url)
const pagingPath = new URL('../frontend/src/lib/homepageCharacterPaging.ts', import.meta.url)

describe('preserved homepage character library contracts', () => {
  test('keeps the original composed component and hook ownership intact', () => {
    const component = readFileSync(componentPath, 'utf8')
    const hook = readFileSync(hookPath, 'utf8')

    expect(component).toContain('export function HomepageCharacterLibrary()')
    expect(component).toContain("from './HomepageCharacterLibrary.module.css'")
    expect(component).toContain('useHomepageCharacterLibrary()')
    expect(hook).toContain("useStore((s) => s.homepageCharacterLibrarySettings)")
    expect(hook).toContain("setSetting('homepageCharacterLibrarySettings'")
    expect(hook).toContain('charactersApi.getHomepagePreview')
  })

  test('keeps the original visual stylesheet and paging implementation present', () => {
    const stylesheet = readFileSync(stylesheetPath, 'utf8')
    const paging = readFileSync(pagingPath, 'utf8')

    expect(stylesheet).toContain('.library')
    expect(stylesheet).toContain('.grid')
    expect(stylesheet).toContain('.preview')
    expect(stylesheet).toContain('@media (max-width: 760px)')
    expect(stylesheet.split(/\r?\n/).filter(Boolean).length).toBeGreaterThan(500)
    expect(paging).toContain('export function applyCharacterPage')
    expect(paging).toContain('export function shouldLoadMore')
  })
})
