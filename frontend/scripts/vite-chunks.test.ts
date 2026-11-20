import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rolldown } from 'rolldown'
import config from '../vite.config'

test('locale chunks retain their paths and all functional groups have timing labels', async () => {
  const output = config.build!.rolldownOptions!.output!
  if (Array.isArray(output)) throw new Error('Expected a single app output')
  const splitting = output.codeSplitting
  if (!splitting || typeof splitting !== 'object') throw new Error('Expected locale chunk groups')
  for (const group of splitting.groups ?? []) {
    if (typeof group.name === 'function') expect(group.debugName?.trim()).toBeTruthy()
  }

  const fixture = mkdtempSync(join(tmpdir(), 'lumiverse-locale-chunks-'))
  const warnings: string[] = []
  try {
    for (const lang of ['en', 'fr']) {
      const dir = join(fixture, 'i18n', 'locales', lang)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'messages.js'), `export const greeting = '${lang}'`)
    }
    const entry = join(fixture, 'main.js')
    writeFileSync(entry, `
      export const english = () => import('./i18n/locales/en/messages.js')
      export const french = () => import('./i18n/locales/fr/messages.js')
    `)
    const bundle = await rolldown({ input: entry, onwarn: (warning) => warnings.push(warning.message) })
    try {
      const result = await bundle.generate({ ...output, format: 'es' })
      const chunks = result.output.filter((item) => item.type === 'chunk')
      expect(chunks.filter((chunk) => chunk.isEntry)).toHaveLength(1)
      expect(chunks.find((chunk) => chunk.name === 'i18n-en')?.fileName).toMatch(/^assets\/i18n\/en-[\w-]+\.js$/)
      expect(chunks.find((chunk) => chunk.name === 'i18n-fr')?.fileName).toMatch(/^assets\/i18n\/fr-[\w-]+\.js$/)
      expect(warnings).toEqual([])
    } finally {
      await bundle.close()
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
})
