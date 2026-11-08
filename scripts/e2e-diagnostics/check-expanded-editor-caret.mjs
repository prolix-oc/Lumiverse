// Real editor, reset and theme variables; controlled API/store/preview boundaries.
// EDITOR_BROWSERS=chromium,firefox,webkit; no server or login required.
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from '../../frontend/node_modules/esbuild/lib/main.js'
import * as playwright from 'playwright'

const root = fileURLToPath(new URL('../../', import.meta.url))
const stubs = {
  '@/store': 'export const useStore = selector => selector({})',
  '@/api/macros': 'export const getMacroCatalog = async () => ({ categories: [] })',
  '@/lib/loom/service': 'export const getAvailableMacros = () => []',
  '@/components/chat/MessageContent': 'export default () => null',
}
const bundle = await build({
  absWorkingDir: root, entryPoints: ['frontend/tests/expanded-editor.fixture.tsx'],
  outfile: 'expanded-editor-fixture.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'controlled-editor', setup(build) {
    build.onResolve({ filter: /^@\// }, args => args.path in stubs ? { path: args.path, namespace: 'stub' } : undefined)
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }],
})
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
const formsOnly = process.argv.includes('--forms-only')
const keyboardOnly = formsOnly || process.argv.includes('--keyboard-only')
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const change = async (page, method, value) => {
  await page.evaluate(([method, value]) => window.expandedEditorFixture[method](value), [method, value])
  await settle(page)
  // Toolbar buttons transition font-size for 150ms. Their wrapping can move
  // the editor after the font itself has updated, invalidating click coordinates.
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))))
  await settle(page)
}
const checkMetrics = async (page, label) => {
  const metrics = await page.evaluate(() => {
    const textarea = document.querySelector('textarea[data-keyboard-caret-managed]'), pre = document.querySelector('pre')
    const a = getComputedStyle(textarea), b = getComputedStyle(pre)
    return { font: [a.fontSize, b.fontSize], line: [a.lineHeight, b.lineHeight], scroll: [textarea.scrollHeight, pre.scrollHeight], client: [textarea.clientWidth, pre.clientWidth] }
  })
  assert.equal(metrics.font[0], metrics.font[1], `${label} font size`)
  assert.equal(metrics.line[0], metrics.line[1], `${label} line height`)
  assert.equal(metrics.client[0], metrics.client[1], `${label} wrapping width`)
  assert.ok(Math.abs(metrics.scroll[0] - metrics.scroll[1]) <= 1, `${label} wrapping: ${JSON.stringify(metrics)}`)
}

// Simulate the two host contracts: Android resizes the WebView itself, while
// iOS keeps the shell full-height and reports a smaller/panned visual viewport.
// Physical keyboard animations remain a device check.
const checkKeyboardLayout = async (page, name) => {
  const near = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 2, `${name} ${label}: ${actual} vs ${expected}`)
  await change(page, 'setInline', false)
  await change(page, 'setOpen', false)
  await change(page, 'setShowShell', true)
  await change(page, 'setFontScale', 1)
  for (const platform of formsOnly ? ['ios', 'ios-pwa'] : ['android', 'ios', 'ios-pwa']) {
    await page.evaluate(platform => {
      document.documentElement.removeAttribute('data-tauri-desktop')
      document.documentElement.removeAttribute('data-ios-pwa')
      document.documentElement.removeAttribute('data-tauri-mobile')
      if (platform === 'ios-pwa') document.documentElement.setAttribute('data-ios-pwa', '')
      else document.documentElement.setAttribute('data-tauri-mobile', platform)
      document.documentElement.setAttribute('data-platform', platform === 'ios-pwa' ? 'ios' : platform)
    }, platform)
    for (const scale of [1, 0.8, 1.25]) {
      await change(page, 'setUiScale', scale)
      for (const visibleHeight of [844, 520, 844, 460, 844]) {
        const focused = visibleHeight !== 844
        await page.setViewportSize({ width: 390, height: platform === 'android' ? visibleHeight : 844 })
        await change(page, 'setViewport', { height: visibleHeight, fullHeight: 844, offsetTop: platform !== 'android' && focused ? 140 : 0, focused })
        const boxes = await page.evaluate(() => {
          const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON()
          return { shell: box('[data-fixture-shell]'), wallpaper: box('[data-fixture-wallpaper]'),
            header: box('[data-fixture-header]'), composer: box('[data-fixture-composer]'), scrollY }
        })
        near(boxes.header.top, 0, `${platform} header stays visible`)
        near(boxes.wallpaper.bottom, platform === 'android' ? visibleHeight : 844, `${platform} wallpaper covers shell`)
        near(boxes.composer.bottom, visibleHeight, `${platform} composer clears keyboard once`)
        near(boxes.scrollY, 0, `${platform} document does not scroll`)
        if (!focused) continue
        if (!formsOnly) {
        await change(page, 'setOpen', true)
        const editor = page.locator('textarea[data-keyboard-caret-managed]')
        const geometry = async () => page.evaluate(() => {
          const dialog = document.querySelector('[class*="ExpandedTextEditor_dialog"]')
          return { dialog: dialog.getBoundingClientRect().toJSON(),
            backdrop: dialog.parentElement.parentElement.getBoundingClientRect().toJSON() }
        })
        for (const highlighted of [true, false]) for (const lineCount of [1, 20, 80]) {
          await change(page, 'setHighlighted', highlighted)
          const draft = Array.from({ length: lineCount }, (_, i) => `Line ${i}: {{char}} text`).join('\n') + '\n\n'
          await change(page, 'setValue', draft)
          // Start with the keyboard closed, then open it with the caret at the
          // end. Short values include a tail that initially fits the full field.
          await change(page, 'setViewport', { height: 844, fullHeight: 844, focused: false })
          await editor.evaluate(el => {
            el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length)
            el.dispatchEvent(new Event('select'))
          })
          await settle(page)
          const before = await geometry()
          await change(page, 'setViewport', { height: visibleHeight, fullHeight: 844, offsetTop: platform !== 'android' ? 140 : 0, focused: true })
          const open = await geometry()
          near(open.backdrop.bottom, 844, `${platform} editor backdrop fills shell`)
          near(open.dialog.top, 0, `${platform} editor ignores stale pan`)
          near(open.dialog.bottom, before.dialog.bottom, `${platform} fullscreen frame does not shrink`)
          near(open.dialog.bottom, 844, `${platform} editor extends behind keyboard`)
          const caret = await page.evaluate(() => window.expandedEditorFixture.getCaret())
          assert.ok(caret && caret.bottom <= visibleHeight + 1 && caret.top >= open.dialog.top,
            `${name}/${platform}/ui=${scale}/highlighted=${highlighted}/lines=${lineCount} caret clears keyboard: ${JSON.stringify(caret)}`)
          assert.equal(await editor.evaluate(el => el.selectionEnd), draft.length, 'keyboard does not rewrite selection')
          await checkMetrics(page, `${name}/${platform}/ui=${scale}/keyboard/highlighted=${highlighted}`)
          if (lineCount === 80) {
            // iOS may report a forward range even when the upper handle moves.
            // Native handle autoscroll must survive every selection notification
            // and viewport callback while the lower endpoint stays offscreen.
            for (const direction of ['forward', 'backward', 'none']) {
              for (const start of [Math.floor(draft.length / 2), 0]) {
                await editor.evaluate((el, { start, direction }) => {
                  el.setSelectionRange(start, el.value.length, direction)
                  el.scrollTop = 20
                  el.dispatchEvent(new Event('select'))
                  document.dispatchEvent(new Event('selectionchange'))
                  visualViewport.dispatchEvent(new Event('scroll'))
                }, { start, direction })
                await settle(page)
                near(await editor.evaluate(el => el.scrollTop), 20, `${platform} selection handle owns scrolling (${direction})`)
                assert.deepEqual(await editor.evaluate(el => [el.selectionStart, el.selectionEnd]), [start, draft.length])
              }
            }
            await editor.evaluate(el => {
              el.setSelectionRange(el.value.length, el.value.length)
              el.dispatchEvent(new Event('select'))
            })
            await settle(page)
            await editor.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')) })
            await settle(page)
            await change(page, 'setViewport', { height: visibleHeight, fullHeight: 844, offsetTop: platform !== 'android' ? 140 : 0, focused: true })
            near(await editor.evaluate(el => el.scrollTop), 0, 'duplicate viewport event respects reading scroll')
            // A real selection request resumes caret following.
            await editor.evaluate(el => el.dispatchEvent(new Event('click')))
            await settle(page)
            assert.ok((await page.evaluate(() => window.expandedEditorFixture.getCaret())).bottom <= visibleHeight + 1, 'caret follows a new editing request')
          }
          await editor.blur()
          await change(page, 'setViewport', { height: visibleHeight, fullHeight: 844, offsetTop: 140, focused: false })
          near((await geometry()).dialog.bottom, 844, `${platform} dismissal keeps fullscreen frame`)
          assert.equal(await editor.inputValue(), draft, 'resize preserves draft')
        }
        await change(page, 'setOpen', false)
        }
        if (platform !== 'android') {
          await change(page, 'setShowForm', true)
          const field = page.getByRole('textbox', { name: 'Form text' })
          await change(page, 'setViewport', { height: 844, focused: false })
          await field.evaluate(el => { el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length) })
          await change(page, 'setViewport', { height: visibleHeight, offsetTop: 140, focused: true })
          const form = await page.locator('[data-component="KeyboardFixture"]').boundingBox()
          near(form.y + form.height, 844, 'shared fullscreen modal frame stays behind keyboard')
          const formCaret = await page.evaluate(() => window.expandedEditorFixture.getFormCaret())
          const formGeometry = await page.evaluate(() => {
            const field = document.querySelector('textarea[aria-label="Form text"]'), mirror = document.querySelector('[data-keyboard-caret-mirror]')
            const container = document.querySelector('[data-fixture-form-scroll]')
            return { field: field.getBoundingClientRect().toJSON(), mirror: mirror.getBoundingClientRect().toJSON(),
              container: container.getBoundingClientRect().toJSON(), scroll: [field.scrollTop, mirror.scrollTop, container.scrollTop],
              size: [container.scrollHeight, container.clientHeight], padding: getComputedStyle(container).paddingBottom }
          })
          assert.ok(formCaret && formCaret.bottom <= visibleHeight + 1, `${name}/${platform}/ui=${scale} form caret clears keyboard: ${JSON.stringify({ caret: formCaret, ...formGeometry })}`)
          assert.ok(await page.locator('[data-fixture-form-scroll]').evaluate(el => el.scrollTop > 0), 'ordinary textarea scrolls its form')
          await page.getByRole('textbox', { name: 'Form name' }).focus()
          await settle(page)
          const fieldBox = await page.getByRole('textbox', { name: 'Form name' }).boundingBox()
          assert.ok(fieldBox.y + fieldBox.height <= visibleHeight + 1, 'ordinary input scrolls into view')
          await change(page, 'setShowForm', false)
        }
      }
    }
  }
  // The new content wrapper must leave ordinary backdrop dismissal working.
  await page.setViewportSize({ width: 1200, height: 900 })
  await change(page, 'setUiScale', 1)
  await change(page, 'setViewport', { height: 900, focused: false })
  await change(page, 'setOpen', true)
  await page.mouse.click(5, 5)
  assert.equal(await page.locator('textarea[data-keyboard-caret-managed]').count(), 0, 'backdrop click closes editor')
  console.log(formsOnly ? `${name}: fullscreen form frame and caret scrolling checks passed`
    : `${name}: fullscreen keyboard frame, caret scrolling, stale iOS dismissal, scaling and backdrop checks passed`)
}

let cases = 0
for (const name of (process.argv.find(arg => arg.startsWith('--browsers='))?.split('=')[1] ?? process.env.EDITOR_BROWSERS ?? 'chromium,firefox,webkit').split(',')) {
  const browser = await playwright[name].launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    page.setDefaultTimeout(5000)
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent(`<html data-tauri-desktop data-platform="macos"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}</style></head><body><div id="root"></div></body></html>`)
    await page.addScriptTag({ content: js })
    await page.waitForFunction(() => !!window.expandedEditorFixture)
    if (!keyboardOnly) {
    const initialValue = await page.locator('textarea').inputValue()
    for (const width of [1200, 800, 390]) for (const uiScale of [1, 0.8, 1.25]) for (const highlighted of [true, false]) {
      await page.setViewportSize({ width, height: 900 })
      await change(page, 'setUiScale', uiScale)
      await change(page, 'setHighlighted', highlighted)
      for (const fontScale of [1, 0.85, 1.05, 1.25, 1.5, 1.75, 2, 1]) {
        const label = `${name}/${width}/ui=${uiScale}/highlighted=${highlighted}/font=${fontScale}`
        await change(page, 'setFontScale', fontScale)
        await page.locator('textarea').evaluate(el => {
          el.focus({ preventScroll: true }); el.setSelectionRange(0, 0); el.scrollTop = 0
          document.querySelector('pre').scrollTop = 0
        })
        await settle(page)
        await checkMetrics(page, label)
        // Only highlighted fields paint a mirror to click against. A hidden
        // plain mirror can return empty Range rectangles in some browsers.
        for (const offset of highlighted ? [5, 50, 90, 185, 360, 640] : []) {
          const caret = await page.evaluate(offset => {
            const pre = document.querySelector('pre'), textarea = document.querySelector('textarea')
            const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
            let node, remaining = offset
            while ((node = walker.nextNode())) {
              if (remaining >= node.textContent.length) { remaining -= node.textContent.length; continue }
              const range = document.createRange()
              range.setStart(node, remaining); range.collapse(true)
              const rect = range.getBoundingClientRect(), box = textarea.getBoundingClientRect()
              return rect.top > box.top + 16 && rect.bottom < box.bottom - 16 ? rect.toJSON() : null
            }
          }, offset)
          if (!caret) continue
          await page.mouse.click(caret.x + 0.5, caret.y + caret.height / 2)
          await settle(page)
          const actual = await page.locator('textarea').evaluate(el => el.selectionStart)
          assert.equal(actual, offset, `${label} native caret at ${offset}`)
        }
        assert.deepEqual(errors, [], `${label} browser errors`)
        cases++
      }
      if (uiScale === 1.25 && !highlighted) console.log(`${name}/${width}: font and UI scale checks passed`)
    }
    // Keep short/empty fields aligned too, and exercise the shared inline styles.
    await page.setViewportSize({ width: 800, height: 900 })
    await change(page, 'setUiScale', 1.25)
    await change(page, 'setFontScale', 1.75)
    for (const inline of [false, true]) for (const highlighted of [true, false]) {
      await change(page, 'setInline', inline)
      await change(page, 'setHighlighted', highlighted)
      for (const value of ['', 'short {{char}}\n\n', initialValue]) {
        await change(page, 'setValue', value)
        await checkMetrics(page, `${name}/inline=${inline}/highlighted=${highlighted}/length=${value.length}`)
        cases++
      }
      // A real click and edit after scrolling into a long document must target
      // the visible character even after fonts and wrapping widths change.
      await page.locator('textarea').evaluate(el => {
        el.focus({ preventScroll: true }); el.setSelectionRange(0, 0)
      })
      await settle(page)
      await page.locator('textarea').evaluate(el => { el.scrollTop = (el.scrollHeight - el.clientHeight) / 2 })
      await settle(page)
      const scrolls = await page.evaluate(() => [document.querySelector('textarea').scrollTop, document.querySelector('pre').scrollTop])
      assert.ok(Math.abs(scrolls[0] - scrolls[1]) <= 1, `${name} mirrored scroll: ${scrolls}`)
      if (!highlighted) continue
      const target = await page.evaluate(() => {
        const textarea = document.querySelector('textarea'), pre = document.querySelector('pre')
        const box = textarea.getBoundingClientRect(), walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT)
        let node, offset = 0
        while ((node = walker.nextNode())) {
          for (let i = 0; i < node.textContent.length; i += 7) {
            if (/\s/.test(node.textContent[i])) continue
            const range = document.createRange()
            range.setStart(node, i); range.collapse(true)
            const rect = range.getBoundingClientRect()
            if (rect.top > box.top + 40 && rect.bottom < box.bottom - 40) return { offset: offset + i, x: rect.x + 0.5, y: rect.y + rect.height / 2 }
          }
          offset += node.textContent.length
        }
        return { error: 'no caret', box: box.toJSON(), scroll: [textarea.scrollTop, pre.scrollTop], length: offset }
      })
      assert.ok(target && !target.error, `${name}/inline=${inline}/highlighted=${highlighted} mirrored scroll and visible caret: ${JSON.stringify(target)}`)
      await page.mouse.click(target.x, target.y)
      await settle(page)
      assert.equal(await page.locator('textarea').evaluate(el => el.selectionStart), target.offset, `${name} scrolled caret`)
      await page.keyboard.insertText('!')
      assert.equal(await page.locator('textarea').inputValue(), initialValue.slice(0, target.offset) + '!' + initialValue.slice(target.offset), `${name} scrolled edit`)
    }
    }
    await checkKeyboardLayout(page, name)
    assert.deepEqual(errors, [], `${name} browser errors`)
    await page.close()
  } finally { await browser.close() }
  if (!keyboardOnly) console.log(`${name}: font scale caret checks passed`)
}
if (cases) console.log(`${cases} expanded editor scale cases passed`)
