import { afterEach, beforeEach, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { resolveConfig } from 'vite'

const root = resolve(import.meta.dirname, '..')
const keys = ['LUMIVERSE_BUNDLED_DEV', 'LUMIVERSE_CHUNK_IMPORT_MAP', 'LUMIVERSE_REACT_COMPILER']
let previous: Record<string, string | undefined>
beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  for (const key of keys) delete process.env[key]
})
afterEach(() => {
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})
const config = (command: 'serve' | 'build') => resolveConfig({
  root, configFile: resolve(root, 'vite.config.ts'), logLevel: 'silent',
}, command)

test('ordinary Vite development uses bundled modules and the native Compiler', async () => {
  const resolved = await config('serve')
  expect(resolved.environments.client.isBundled).toBe(true)
  expect(resolved.plugins.some(plugin => plugin.name === 'vite:react-compiler')).toBe(true)
  expect(resolved.build.rolldownOptions.output).toMatchObject({ strictExecutionOrder: true })
})

test('ordinary production builds include chunk import maps and the native Compiler', async () => {
  const resolved = await config('build')
  expect(resolved.build.chunkImportMap).toBe(true)
  expect(resolved.plugins.some(plugin => plugin.name === 'vite:react-compiler')).toBe(true)
})

test('compatibility environment switches resolve to the previous tooling', async () => {
  process.env.LUMIVERSE_BUNDLED_DEV = '0'
  process.env.LUMIVERSE_CHUNK_IMPORT_MAP = '0'
  process.env.LUMIVERSE_REACT_COMPILER = 'babel'
  const development = await config('serve')
  const production = await config('build')
  expect(development.environments.client.isBundled).toBe(false)
  expect(production.build.chunkImportMap).toBe(false)
  expect(production.plugins.some(plugin => plugin.name === 'vite:react-compiler')).toBe(false)
})
