import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

import { joinComponentRegistryPaths } from './componentRegistryJoin'

const cssRegistrySource = await readFile(new URL('./cssModuleRegistry.ts', import.meta.url), 'utf8')
const extractPropsSource = await readFile(new URL('../../scripts/extract-props.ts', import.meta.url), 'utf8')

describe('component registry join drift guard', () => {
  test('joins by canonical path identity while retaining input order and orphans', () => {
    const cssPaths = [
      'C:/workspace/src/components/chat/Paired.module.css',
      'C:/workspace/src/components/chat/CssOnly.module.css',
    ]
    const tsxPaths = [
      'C:\\workspace\\src\\components\\chat\\TsxOnly.tsx',
      'C:/workspace/src/components/chat/Paired.tsx',
    ]

    expect(joinComponentRegistryPaths(cssPaths, tsxPaths)).toEqual([
      {
        component: 'Paired',
        category: 'Chat',
        cssPath: cssPaths[0],
        tsxPath: tsxPaths[1],
      },
      {
        component: 'CssOnly',
        category: 'Chat',
        cssPath: cssPaths[1],
        tsxPath: null,
      },
      {
        component: 'TsxOnly',
        category: 'Chat',
        cssPath: null,
        tsxPath: tsxPaths[0],
      },
    ])
  })

  test('keeps CSS and prop extraction consumers on the canonical join', () => {
    expect(cssRegistrySource).toContain('joinComponentRegistryPaths')
    expect(extractPropsSource).toContain('joinComponentRegistryPaths')
    expect(extractPropsSource).toContain('componentRegistryKeyFromPath(entry.tsxPath!)')
    expect(extractPropsSource).toContain('componentRegistryKeyFromPath(filePath)')
    expect(cssRegistrySource).not.toMatch(/function\s+(?:nameFromPath|categoryFromPath|isExcluded)\s*\(/)
    expect(extractPropsSource).not.toMatch(/path\.join\(dir,\s*`\$\{componentName\}\.module\.css`\)/)
  })
})
