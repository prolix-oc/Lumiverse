import assert from 'node:assert/strict'
import { launchTestBrowser } from './browser-runtime.mjs'

for (const name of process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit']) {
  const runtime = await launchTestBrowser(name)
  try {
    const page = await runtime.browser.newPage()
    await page.setContent('<label>Browser check <input></label><output></output>')
    await page.getByRole('textbox').fill('ready')
    await page.getByRole('textbox').evaluate(input => {
      document.querySelector('output').textContent = input.value
    })
    assert.equal(await page.locator('output').textContent(), 'ready')
    console.log(`${name} ${runtime.browser.version()}: launch, rendering and input pass`)
  } finally {
    await runtime.close()
  }
}
