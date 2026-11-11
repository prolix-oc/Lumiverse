import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const directory = mkdtempSync(join(tmpdir(), 'spindle-uuid-'))
try {
  const entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js')
  const source = join(root, 'frontend/src/lib/spindle/uuid-api.ts').replaceAll('\\', '/')
  writeFileSync(entry, `import { createFrontendUUIDAPI, SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES } from ${JSON.stringify(source)};
let active = true, generation = 0;
const create = () => { const ownGeneration = ++generation; return createFrontendUUIDAPI(() => { if (!active || ownGeneration !== generation) throw new Error('Extension unloaded'); }); };
let api = create();
window.fixture = {
  capabilities: SPINDLE_FRONTEND_UUID_HOST_CAPABILITIES,
  get api() { return api; },
  unload() { active = false; },
  remount() { active = true; api = create(); },
};`)
  const build = spawnSync('bun', ['build', entry, '--target=browser', '--outfile=' + bundle], { encoding: 'utf8', windowsHide: true })
  assert.equal(build.status, 0, build.stderr)
  const script = readFileSync(bundle, 'utf8')
  for (const name of (process.env.UUID_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const launched = await launchTestBrowser(name)
    try {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const page = await launched.browser.newPage({ viewport })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        // A non-loopback HTTP origin matters: localhost is a secure context.
        await page.route('http://spindle-uuid.test/**', route => route.fulfill({
          contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body></body></html>',
        }))
        await page.goto('http://spindle-uuid.test/')
        assert.equal(await page.evaluate(() => isSecureContext), false)
        assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined')
        await page.addScriptTag({ content: script })
        const result = await page.evaluate(() => {
          const { fixture } = window
          const retained = fixture.api
          const ids = Array.from({ length: 256 }, () => [retained.v4(), retained.v7()]).flat()
          const draft = { id: retained.v4(), blocks: [{ id: retained.v7(), name: 'Local prompt' }] }
          fixture.unload()
          const rejected = [retained.v4, retained.v7].map(method => {
            try { method(); return false } catch (error) { return error.message === 'Extension unloaded' }
          })
          fixture.remount()
          const freshId = fixture.api.v4()
          const staleAfterRemount = [retained.v4, retained.v7].every(method => {
            try { method(); return false } catch (error) { return error.message === 'Extension unloaded' }
          })
          return { ids, draft, rejected, freshId, staleAfterRemount, fresh: fixture.api !== retained,
            frozen: Object.isFrozen(fixture.api), capability: fixture.capabilities['frontend-uuid-v1'] }
        })
        assert.deepEqual(errors, [])
        assert.equal(new Set(result.ids).size, result.ids.length)
        for (const [index, id] of result.ids.entries()) {
          assert.equal(typeof id, 'string')
          assert.match(id, new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-${index % 2 ? 7 : 4}[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`))
        }
        assert.equal(typeof result.draft.id, 'string')
        assert.equal(typeof result.draft.blocks[0].id, 'string')
        assert.deepEqual(result.rejected, [true, true])
        assert.equal(result.fresh, true)
        assert.equal(result.staleAfterRemount, true)
        assert.equal(result.frozen, true)
        assert.equal(result.capability, 1)
        assert.equal(result.ids.includes(result.freshId), false)
        await page.close()
        console.log(`${name} ${viewport.width}px: insecure HTTP, synchronous drafts, unique UUIDs, unload and remount passed`)
      }
    } finally { await launched.close() }
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
