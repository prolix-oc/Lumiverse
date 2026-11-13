import { afterEach, expect, test } from 'bun:test'
import { hasNativeDownloadCompletion, triggerBlobDownload, triggerUrlDownload } from './downloads'

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
  else Reflect.deleteProperty(globalThis, 'window')
})

test('shared download helpers await the Android completion API for Blob and URL exports', async () => {
  for (const kind of ['blob', 'url']) {
    let finish!: () => void
    const nativeSave = new Promise<void>(resolve => { finish = resolve })
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      location: { href: 'https://lumiverse.example/' },
      lumiverseNativeDownloads: { saveBlob: () => nativeSave, saveUrl: () => nativeSave },
    } })
    expect(hasNativeDownloadCompletion()).toBe(true)
    let finished = false
    const saved = (kind === 'blob' ? triggerBlobDownload(new Blob(['card']), 'card.png') : triggerUrlDownload('/card.charx', 'card.charx')).then(() => { finished = true })
    await Bun.sleep(0)
    expect(finished).toBe(false)
    finish()
    await saved
    expect(finished).toBe(true)
  }
})
