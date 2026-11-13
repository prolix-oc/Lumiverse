import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { act, StrictMode, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { useComposerDraft } from './useComposerDraft'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://lumiverse.test' })
Object.assign(globalThis, {
  window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
})

let root: Root
let host: HTMLDivElement
let composer: ReturnType<typeof useComposerDraft>
function Probe({ chatId, save = true }: { chatId: string; save?: boolean }) {
  const current = useComposerDraft(chatId, save)
  useLayoutEffect(() => { composer = current })
  return <textarea value={current.text} readOnly />
}
const key = (id = 'a') => `lumiverse:composerDraft:v1:${id}`
const saved = (id = 'a') => JSON.parse(localStorage.getItem(key(id)) || 'null')
const attachment = {
  type: 'image' as const, image_id: 'uploaded-image', mime_type: 'image/png',
  original_filename: 'picture.png', previewUrl: 'blob:transient-preview',
}
async function render(chatId = 'a', save = true) {
  await act(async () => { root.render(<StrictMode><Probe chatId={chatId} save={save} /></StrictMode>) })
}
async function remount(chatId = 'a') {
  await act(async () => root.unmount())
  root = createRoot(host)
  await render(chatId)
}

beforeEach(() => {
  localStorage.clear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

describe('composer draft recovery', () => {
  test('persists the latest keystroke immediately and recovers on an immediate remount', async () => {
    await render()
    await act(async () => {
      composer.setText('last character!')
      // Storage is durable even before React paints the edit.
      expect(saved().text).toBe('last character!')
    })
    await remount()
    expect(composer.text).toBe('last character!')
    expect(host.querySelector('textarea')?.value).toBe('last character!')
  })

  test('restores existing drafts without an initial empty render erasing them', async () => {
    localStorage.setItem('lumiverse:chatDraft:a', 'legacy unsent message')
    await render()
    expect(composer.text).toBe('legacy unsent message')
    expect(saved().text).toBe('legacy unsent message')
    expect(localStorage.getItem('lumiverse:chatDraft:a')).toBeNull()
  })

  test('keeps independent drafts when switching to a chat without a saved draft', async () => {
    await render()
    await act(async () => composer.setText('chat a draft'))
    await render('b')
    expect(composer.text).toBe('')
    await act(async () => composer.setText('chat b draft'))
    await render('a')
    expect(composer.text).toBe('chat a draft')
    expect(saved('b').text).toBe('chat b draft')
  })

  test('recovers uploaded attachment references with the text after a refresh', async () => {
    await render()
    await act(async () => {
      composer.setText('with a picture')
      composer.setAttachments([attachment])
    })
    expect(saved().attachments[0].previewUrl).toBeUndefined()
    await remount()
    expect(composer.text).toBe('with a picture')
    expect(composer.attachments[0].image_id).toBe('uploaded-image')
  })

  test('retains the submitted draft until the caller acknowledges a successful save', async () => {
    await render()
    await act(async () => {
      composer.setText('send this')
      composer.setAttachments([attachment])
    })
    const submitted = composer.draft
    await remount()
    expect(composer.text).toBe(submitted.text)
    expect(composer.attachments).toHaveLength(1)
  })

  test('clears only acknowledged content and preserves edits and uploads made in flight', async () => {
    await render()
    await act(async () => {
      composer.setText('first message')
      composer.setAttachments([attachment])
    })
    const submitted = composer.draft
    const laterUpload = { ...attachment, image_id: 'second-upload' }
    await act(async () => {
      composer.setText('next message')
      composer.setAttachments((current) => [...current, laterUpload])
      composer.acknowledgeDraft(submitted)
    })
    expect(composer.text).toBe('next message')
    expect(composer.attachments).toEqual([laterUpload])
    await remount()
    expect(composer.text).toBe('next message')
    expect(composer.attachments.map((a) => a.image_id)).toEqual(['second-upload'])
  })

  test('an acknowledged message does not reappear as an unsent draft on refresh', async () => {
    await render()
    await act(async () => {
      composer.setText('saved message')
      composer.setAttachments([attachment])
    })
    await act(async () => composer.acknowledgeDraft(composer.draft))
    expect(localStorage.getItem(key())).toBeNull()
    await remount()
    expect(composer.text).toBe('')
    expect(composer.attachments).toEqual([])
  })

  test('a late acknowledgement clears its original chat without clearing the next chat', async () => {
    await render()
    await act(async () => composer.setText('pending a'))
    const pending = composer
    await render('b')
    await act(async () => composer.setText('draft b'))
    await act(async () => pending.acknowledgeDraft(pending.draft))
    expect(localStorage.getItem(key('a'))).toBeNull()
    expect(saved('b').text).toBe('draft b')
    expect(composer.text).toBe('draft b')
  })

  test('an old request cannot overwrite a newer mount of the same chat', async () => {
    await render()
    await act(async () => composer.setText('old request'))
    const pending = composer
    await remount()
    await act(async () => composer.setText('new work'))
    await act(async () => pending.acknowledgeDraft(pending.draft))
    expect(saved().text).toBe('new work')
    expect(composer.text).toBe('new work')
  })

  test('deleting a draft is also immediate and does not resurrect older text', async () => {
    await render()
    await act(async () => composer.setText('deleted'))
    await act(async () => composer.setText(''))
    await remount()
    expect(composer.text).toBe('')
  })

  test('honors disabled persistence while retaining a failed-send draft in memory', async () => {
    await render('a', false)
    await act(async () => composer.setText('private draft'))
    expect(composer.text).toBe('private draft')
    expect(localStorage.length).toBe(0)
    await render('a', true)
    expect(saved().text).toBe('private draft')
    await render('a', false)
    expect(localStorage.length).toBe(0)
    expect(composer.text).toBe('private draft')
  })

  test('storage failures do not crash edits or acknowledgement', async () => {
    await render()
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('storage blocked') } })
    try {
      await act(async () => composer.setText('still editable'))
      expect(composer.text).toBe('still editable')
      await act(async () => composer.acknowledgeDraft(composer.draft))
      expect(composer.text).toBe('')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', original)
    }
  })
})
