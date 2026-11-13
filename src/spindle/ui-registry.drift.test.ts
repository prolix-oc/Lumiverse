import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BUILT_IN_DRAWER_TABS, BUILT_IN_SETTINGS_TABS } from './ui-registry'

function frontendIds(source: string, registry: string): string[] {
  const entries = source.match(new RegExp(`^export const ${registry}[^=]*=\\s*\\[([\\s\\S]*?)^\\]`, 'm'))?.[1]
  expect(entries).toBeDefined()
  return [...entries!.matchAll(/^\s+id:\s*'([^']+)'/gm)].map((match) => match[1])
}

describe('frontend/backend H4 registry mirror', () => {
  test('built-in drawer ids stay in sync', async () => {
    const source = await readFile(join(import.meta.dir, '../../frontend/src/lib/drawer-tab-registry.tsx'), 'utf8')
    expect(BUILT_IN_DRAWER_TABS.map((tab) => tab.id)).toEqual(frontendIds(source, 'DRAWER_TABS'))
  })

  test('Council legacy navigation aliases are excluded from built-in drawer listings', async () => {
    const source = await readFile(join(import.meta.dir, '../../frontend/src/lib/drawer-tab-registry.tsx'), 'utf8')
    const aliases = frontendIds(source, 'COUNCIL_DRAWER_ALIASES')
    expect(aliases).toEqual(['ooc', 'feedback'])
    for (const alias of aliases) {
      expect(BUILT_IN_DRAWER_TABS.some((tab) => tab.id === alias)).toBe(false)
      expect(BUILT_IN_DRAWER_TABS.find((tab) => tab.id === 'council')?.keywords).toContain(alias)
    }
  })

  test('built-in settings ids stay in sync', async () => {
    const source = await readFile(join(import.meta.dir, '../../frontend/src/lib/settings-tab-registry.tsx'), 'utf8')
    expect(BUILT_IN_SETTINGS_TABS.map((tab) => tab.id)).toEqual(frontendIds(source, 'SETTINGS_TABS'))
  })
})
