import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { build } from 'vite'
import config from '../vite.config'

let fixture: string | undefined
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true })
  fixture = undefined
})

test('shared frontend source uses the frontend Spindle package when the backend copy is older', async () => {
  fixture = mkdtempSync(join(tmpdir(), 'lumiverse-shared-dependencies-'))
  const frontend = join(fixture, 'frontend')
  const shared = join(fixture, 'src/shared')
  mkdirSync(shared, { recursive: true })
  for (const file of ['connection-organization.ts', 'connection-library.ts', 'connection-recents.ts']) {
    copyFileSync(resolve(import.meta.dirname, '../../src/shared', file), join(shared, file))
  }
  for (const [root, source] of [
    [fixture, 'export const olderPackage = true'],
    [frontend, "export const SPINDLE_CONNECTION_ORGANIZATION_HOST_CAPABILITIES = Object.freeze({ 'connection-organization-v1': 1 })"],
  ] as const) {
    const pkg = join(root, 'node_modules/lumiverse-spindle-types')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'lumiverse-spindle-types', type: 'module', exports: './index.js' }))
    writeFileSync(join(pkg, 'index.js'), source)
  }
  const entry = join(frontend, 'entry.ts')
  writeFileSync(entry, "export { CONNECTION_ORGANIZATION_CAPABILITIES } from '../src/shared/connection-organization'")

  const result = await build({
    configFile: false,
    root: frontend,
    resolve: config.resolve,
    logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
  })
  const builds = Array.isArray(result) ? result : [result]
  const chunk = builds.flatMap(item => 'output' in item ? item.output : []).find(item => item.type === 'chunk')
  expect(chunk?.type === 'chunk' && chunk.code).toContain('connection-organization-v1')
})

test('Docker frontend sources include all shared runtime imports and their dependencies', async () => {
  const repository = resolve(import.meta.dirname, '../..')
  const frontendSource = join(repository, 'frontend')
  fixture = mkdtempSync(join(tmpdir(), 'lumiverse-docker-frontend-'))
  const frontend = join(fixture, 'frontend')
  mkdirSync(frontend, { recursive: true })
  symlinkSync(join(frontendSource, 'node_modules'), join(frontend, 'node_modules'), 'junction')

  // Reproduce the shared-source COPY set, with no backend checkout or packages
  // available to hide missing files in the isolated frontend stage.
  const stage = readFileSync(join(repository, 'Dockerfile'), 'utf8').replaceAll('\r\n', '\n')
    .split('AS frontend-build')[1].split('\nFROM ')[0]
  for (const [, source, destination] of stage.matchAll(/^COPY (src\/\S+) (\/app\/\S+)$/gm)) {
    const target = join(fixture, destination.slice('/app/'.length))
    mkdirSync(target, { recursive: true })
    cpSync(join(repository, source), source.endsWith('/') ? target : join(target, source.split('/').pop()!), { recursive: true })
  }

  // Discover production imports so future browser helpers outside frontend/
  // are covered too. The transpiler omits type-only imports.
  const transpilers = { ts: new Bun.Transpiler({ loader: 'ts' }), tsx: new Bun.Transpiler({ loader: 'tsx' }) }
  const shared = new Set<string>()
  for (const file of new Bun.Glob('src/**/*.{ts,tsx}').scanSync({ cwd: frontendSource })) {
    if (/\.(test|spec|d)\.tsx?$/.test(file)) continue
    const path = join(frontendSource, file)
    const transpiler = file.endsWith('.tsx') ? transpilers.tsx : transpilers.ts
    for (const item of transpiler.scan(readFileSync(path, 'utf8')).imports) {
      if (!item.path.startsWith('.')) continue
      const source = resolve(dirname(path), item.path)
      if (relative(frontendSource, source).startsWith(`..${sep}`)) {
        shared.add(relative(repository, source).replaceAll('\\', '/'))
      }
    }
  }
  expect(shared.size).toBeGreaterThan(0)
  const entry = join(frontend, 'entry.ts')
  writeFileSync(entry, [...shared].map((source, index) =>
    `import * as shared${index} from ${JSON.stringify(`../${source}`)}; export { shared${index} };`,
  ).join('\n'))
  await build({
    configFile: false,
    root: frontend,
    resolve: config.resolve,
    logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry, formats: ['es'] } },
  })
})
