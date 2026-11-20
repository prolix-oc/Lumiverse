import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as playwright from 'playwright'

/** Launch the binary matched to the pinned Playwright package, with fresh data. */
export async function launchTestBrowser(name, options = {}) {
  if (!['chromium', 'firefox', 'webkit'].includes(name)) throw new Error(`Unsupported browser: ${name}`)
  let isolatedData
  let browser
  try {
    const launchOptions = { headless: true, timeout: 20000, ...options }
    if (name === 'firefox' && process.platform === 'darwin') {
      // macOS 27 protects the personal Firefox app-data directory even when
      // Firefox uses a temporary -profile. Give tests their own app data too.
      // https://bugzilla.mozilla.org/show_bug.cgi?id=2069536
      isolatedData = await mkdtemp(join(tmpdir(), 'lumiverse-firefox-data-'))
      const appData = join(isolatedData, 'app-data')
      await mkdir(appData)
      launchOptions.env = { ...process.env, ...options.env, MOZ_APP_DATA: appData }
    }
    browser = await playwright[name].launch(launchOptions)
    return {
      browser,
      async close() {
        try { await browser.close() }
        finally { if (isolatedData) await rm(isolatedData, { recursive: true, force: true }) }
      },
    }
  } catch (error) {
    if (isolatedData) await rm(isolatedData, { recursive: true, force: true })
    throw new Error(`${name} launch failed. Install the matching binary with bun run browsers:install.\n${error.message}`, { cause: error })
  }
}
