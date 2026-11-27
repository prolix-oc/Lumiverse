import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

const directory = mkdtempSync(join(tmpdir(), 'warm-display-reflow-'))
try {
  const entry = fileURLToPath(new URL('./fixtures/warm-display-reflow.ts', import.meta.url))
  const bundle = join(directory, 'fixture.js')
  const build = spawnSync('bun', ['build', entry, '--target=browser', '--outfile=' + bundle], { encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr || String(build.error))
  const javascript = readFileSync(bundle, 'utf8')
  for (const name of (process.env.REFLOW_BROWSERS || 'chromium,firefox,webkit').split(',')) {
    const runtime = await launchTestBrowser(name)
    try {
      for (const width of [1280, 390]) {
        const page = await runtime.browser.newPage({ viewport: { width, height: 844 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        try {
          await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style>')
          await page.addScriptTag({ content: javascript })
          const result = await page.evaluate(() => window.runWarmDisplayReflow())
          assert.deepEqual(result, ['restore', 'shorter', 'above', 'below', 'removed', 'restart', 'disposed', 'bounded'])
          assert.deepEqual(errors, [])
          console.log(`${name} ${width}px: ${result.join(', ')} passed`)
        } finally { await page.close() }
      }
    } finally { await runtime.close() }
  }
} finally { rmSync(directory, { recursive: true, force: true }) }
