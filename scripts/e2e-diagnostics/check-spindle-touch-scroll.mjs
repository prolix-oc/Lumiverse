import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchTestBrowser } from './browser-runtime.mjs'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const main = readFileSync(join(root, 'frontend/src/main.tsx'), 'utf8')
assert.match(main, /if\s*\(isIOSStandalonePwa\)\s*\{\s*installIOSTouchScrollGuard\(\)/, 'Installed-iOS guard must be installed by the app')
const directory = mkdtempSync(join(tmpdir(), 'spindle-touch-scroll-'))
try {
  const entry = join(directory, 'fixture.ts'), bundle = join(directory, 'fixture.js')
  const spindle = join(root, 'frontend/src/lib/spindle').replaceAll('\\', '/')
  const guard = join(root, 'frontend/src/lib/iosTouchScroll.ts').replaceAll('\\', '/')
  writeFileSync(entry, `import { registerLiveRoot } from ${JSON.stringify(spindle + '/live-root-registry.ts')};
import { setWidgetTouchScrollMode, usesNativeWidgetTouchScroll } from ${JSON.stringify(spindle + '/widget-touch-scroll.ts')};
import { installIOSTouchScrollGuard } from ${JSON.stringify(guard)};
window.fixture = { registerLiveRoot, setWidgetTouchScrollMode, usesNativeWidgetTouchScroll, installIOSTouchScrollGuard };`)
  const build = spawnSync('bun', ['build', entry, '--target=browser', '--outfile=' + bundle], { encoding: 'utf8', windowsHide: true })
  assert.equal(build.status, 0, build.stderr)
  for (const name of ['chromium', 'firefox', 'webkit']) {
    const launched = await launchTestBrowser(name)
    const { browser } = launched
    try {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.setContent('<body><div id="core"></div><div id="widget"><div id="other"></div></div></body>')
        await page.addScriptTag({ content: readFileSync(bundle, 'utf8') })
        const results = await page.evaluate(() => {
          const { registerLiveRoot, setWidgetTouchScrollMode, installIOSTouchScrollGuard } = window.fixture
          const stop = installIOSTouchScrollGuard()
          const core = document.querySelector('#core'), widget = document.querySelector('#widget'), other = document.querySelector('#other')
          const off = registerLiveRoot('a', widget, 'ui_panels', 1)
          const offOther = registerLiveRoot('b', other, 'ui_panels', 1)
          const move = target => {
            const point = { identifier: 1, clientX: 0, clientY: 0 }
            const start = new Event('touchstart', { bubbles: true, composed: true })
            Object.defineProperty(start, 'touches', { value: [point] })
            target.dispatchEvent(start)
            const event = new Event('touchmove', { bubbles: true, composed: true, cancelable: true })
            const moved = [{ ...point, clientY: 20 }]
            Object.defineProperties(event, { touches: { value: moved }, changedTouches: { value: moved } })
            target.dispatchEvent(event); return event.defaultPrevented
          }
          const result = [move(core), move(widget)]
          setWidgetTouchScrollMode(widget, 'native')
          result.push(move(widget), move(core), move(other))
          const child = document.createElement('button')
          widget.attachShadow({ mode: 'open' }).append(child)
          result.push(move(child))
          setWidgetTouchScrollMode(widget, 'guarded')
          result.push(move(child))
          setWidgetTouchScrollMode(widget, 'native')
          off()
          result.push(move(child))
          offOther()
          stop()
          return result
        })
        assert.deepEqual(errors, [])
        assert.deepEqual(results, [true, true, false, true, true, false, true, true])
        await page.close()
        console.log(`${name} ${viewport.width}px: default, opt-in, isolation, shadow content, reversal and teardown passed`)
      }
    } finally { await launched.close() }
  }
  console.log('Synthetic touch cancellation audit passed; physical installed-iOS scrolling is not simulated.')
} finally { rmSync(directory, { recursive: true, force: true }) }
