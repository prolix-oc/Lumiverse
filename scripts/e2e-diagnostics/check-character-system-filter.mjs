import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const directory = await mkdtemp(join(tmpdir(), 'character-system-filter-'))
let server
try {
  const build = spawnSync('bun', ['build', 'frontend/src/api/characters.ts', '--target=browser',
    '--define', 'import.meta.env.VITE_API_BASE="/api/v1"', '--outfile=' + join(directory, 'client.js')], { cwd: root, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  server = spawn('bun', ['--no-env-file', 'scripts/e2e-diagnostics/character-system-filter-server.ts', directory], {
    cwd: root, env: { ...process.env, DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let errors = ''
  server.stderr.on('data', chunk => { errors += chunk })
  const base = await new Promise((resolve, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error('Fixture startup timed out: ' + errors)), 20_000)
    server.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${errors}`)) })
    server.stdout.on('data', chunk => {
      stdout += chunk
      for (const line of stdout.split('\n')) {
        try { const value = JSON.parse(line); if (value.url) { clearTimeout(timer); resolve(value.url) } } catch {}
      }
    })
  })
  for (const engine of (process.env.CHARACTER_FILTER_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const runtime = await launchTestBrowser(engine)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 844 } })
        const pageErrors = []
        page.on('pageerror', error => pageErrors.push(error.message))
        page.on('console', message => { if (message.type() === 'error') pageErrors.push(message.text()) })
        await page.goto(base)
        await page.waitForFunction(() => !!window.hostCharacters)
        const result = await page.evaluate(async () => {
          const ids = await (await fetch('/fixture')).json()
          const rpc = async (options, method = 'list') => (await (await fetch('/rpc', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ options, method }),
          })).json())
          const host = await window.hostCharacters.list()
          const summaries = await window.hostCharacters.listSummaries()
          const defaults = await rpc()
          const explicitFalse = await rpc({ includeSystem: false })
          const all = await rpc({ includeSystem: true })
          const search = await rpc({ search: 'Rooms' })
          const shortSearch = await rpc({ search: 'Ro' })
          const searchAll = await rpc({ search: 'Rooms', includeSystem: true })
          const page = await rpc({ limit: 1, offset: 1 })
          const pastEnd = await rpc({ limit: 1, offset: 2 })
          const direct = await rpc({ id: ids.flagged }, 'get')
          const scoped = await rpc({ userId: 'other-owner', includeSystem: true })
          const invalid = await rpc({ includeSystem: 'true' })
          await fetch('/permission', { method: 'POST', body: JSON.stringify({ granted: false }) })
          const denied = await rpc({ includeSystem: true })
          await fetch('/permission', { method: 'POST', body: JSON.stringify({ granted: true }) })
          document.querySelector('#status').textContent = `${defaults.result.total} extension cards; ${host.total} host cards`
          return { ids, host, summaries, defaults, explicitFalse, all, search, shortSearch, searchAll, page, pastEnd, direct, scoped, invalid, denied }
        })
        const { ordinary, mira, flagged, legacy } = result.ids
        const ids = page => page.data.map(card => card.id).sort()
        for (const host of [result.host, result.summaries, result.all.result, result.scoped.result]) {
          assert.equal(host.total, 4)
          assert.deepEqual(ids(host), [ordinary, mira, flagged, legacy].sort())
        }
        for (const filtered of [result.defaults.result, result.explicitFalse.result]) {
          assert.equal(filtered.total, 2)
          assert.deepEqual(ids(filtered), [ordinary, mira].sort())
        }
        for (const search of [result.search.result, result.shortSearch.result]) {
          assert.equal(search.total, 1)
          assert.deepEqual(ids(search), [ordinary])
        }
        assert.equal(result.searchAll.result.total, 3)
        assert.equal(result.page.result.total, 2)
        assert.equal(result.page.result.data.length, 1)
        assert.equal(result.pastEnd.result.total, 2)
        assert.deepEqual(result.pastEnd.result.data, [])
        assert.equal(result.direct.result.id, flagged)
        assert.match(result.invalid.error, /includeSystem must be a boolean/)
        assert.match(result.denied.error, /permission/i)
        assert.deepEqual(pageErrors, [])
        await page.reload()
        await page.waitForFunction(() => !!window.hostCharacters)
        assert.equal(await page.evaluate(async () => (await window.hostCharacters.list()).total), 4)
        await page.close()
        console.log(`${engine} ${width}px: real worker RPC, default/opt-in filtering, FTS/short search, pagination, direct lookup, host API, user scope, permissions and reload passed`)
      }
    } finally { await runtime.close() }
  }
  assert.equal(errors, '', errors)
} finally {
  if (server && server.exitCode === null) {
    await new Promise(resolve => { server.once('exit', resolve); server.kill('SIGTERM') })
  }
  await rm(directory, { recursive: true, force: true })
}
