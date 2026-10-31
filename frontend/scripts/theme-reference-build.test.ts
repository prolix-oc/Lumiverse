import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { themeReferenceBuild } from './theme-reference-build'

for (const copyPublicDir of [false, true]) {
  test(`theme references are emitted from current sources with public copying ${copyPublicDir ? 'enabled' : 'disabled'}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'theme-reference-build-'))
    const root = join(directory, 'frontend')
    const publicAssets = join(root, 'public/assets')
    const staleAsset = `theme-reference.${'0'.repeat(64)}.json`
    try {
      mkdirSync(join(root, 'src/components'), { recursive: true })
      for (const folder of ['user-docs', 'developer-docs']) {
        mkdirSync(join(directory, folder, 'docs'), { recursive: true })
        writeFileSync(join(directory, folder, 'docs/theme.md'), 'Current theme documentation')
      }
      writeFileSync(join(root, 'package.json'), JSON.stringify({ version: 'test-build' }))
      writeFileSync(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>')
      writeFileSync(
        join(root, 'src/main.ts'),
        `import styles from './components/Fixture.module.css'; document.body.className = styles.root`,
      )
      writeFileSync(join(root, 'src/components/Fixture.module.css'), '.root { color: red }')
      writeFileSync(
        join(root, 'src/components/Fixture.tsx'),
        'export const Fixture = () => <div data-component="Fixture" data-part="body" />',
      )
      writeFileSync(join(root, 'src/components/Unused.module.css'), '.unused { color: blue }')
      if (copyPublicDir) {
        mkdirSync(publicAssets, { recursive: true })
        writeFileSync(join(publicAssets, 'theme-reference-index.json'), 'corrupt old index')
        writeFileSync(join(publicAssets, staleAsset), 'stale reference')
        writeFileSync(join(publicAssets, 'keep.txt'), 'unrelated public asset')
      }

      const rebuild = () => build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [themeReferenceBuild()],
        build: { copyPublicDir, emptyOutDir: true },
      })
      await rebuild()
      const assets = join(root, 'dist/assets')
      const index = JSON.parse(readFileSync(join(assets, 'theme-reference-index.json'), 'utf8'))
      const body = readFileSync(join(root, 'dist', index.asset), 'utf8')
      const reference = JSON.parse(body)
      expect(index.version).toBe('test-build')
      expect(index.hash).toBe(createHash('sha256').update(body).digest('hex'))
      expect(index.asset).toBe(`assets/theme-reference.${index.hash}.json`)
      expect(reference.docs['developer-docs/theme.md']).toBe('Current theme documentation')
      const findComponent = (name: string) => reference.components.find(
        (entry: { component: string }) => entry.component === name,
      )
      const component = findComponent('Fixture')
      expect(component.rootSelector).toBe('[data-component="Fixture"]')
      expect(component.parts).toEqual(['body'])
      expect(component.classSelectors.root).toMatch(/^\./)
      const css = readdirSync(assets).filter((name) => name.endsWith('.css'))
        .map((name) => readFileSync(join(assets, name), 'utf8')).join('\n')
      expect(css).toContain(component.classSelectors.root)
      expect(findComponent('Unused').classSelectors).toEqual({})
      expect(readdirSync(assets).filter((name) => /^theme-reference\.[a-f0-9]{64}\.json$/.test(name)))
        .toHaveLength(1)
      if (copyPublicDir) {
        expect(readFileSync(join(assets, 'keep.txt'), 'utf8')).toBe('unrelated public asset')
        expect(existsSync(join(assets, staleAsset))).toBe(false)
      } else {
        expect(existsSync(publicAssets)).toBe(false)
      }

      writeFileSync(join(directory, 'developer-docs/docs/theme.md'), 'Updated documentation')
      await rebuild()
      const updated = JSON.parse(readFileSync(join(assets, 'theme-reference-index.json'), 'utf8'))
      expect(updated.hash).not.toBe(index.hash)
      const updatedReference = JSON.parse(readFileSync(join(root, 'dist', updated.asset), 'utf8'))
      expect(updatedReference.docs['developer-docs/theme.md'])
        .toBe('Updated documentation')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }, 20_000)
}
