import { beforeEach, describe, expect, test } from 'bun:test'
import { createDesktopDownloadFeedback } from './desktop-download-feedback'

const messages = {
  title: 'Saving download',
  started: (fileName: string) => `Saving ${fileName}`,
  complete: (fileName: string) => `Saved ${fileName}`,
  failed: (fileName: string) => `Failed ${fileName}`,
}

describe('desktop download feedback', () => {
  const notifications: Array<{ type: string; message?: string; id?: string }> = []
  const notifier = {
    info: (message: string) => {
      const id = `toast-${notifications.length + 1}`
      notifications.push({ type: 'info', message, id })
      return id
    },
    success: (message: string) => {
      const id = `toast-${notifications.length + 1}`
      notifications.push({ type: 'success', message, id })
      return id
    },
    error: (message: string) => {
      const id = `toast-${notifications.length + 1}`
      notifications.push({ type: 'error', message, id })
      return id
    },
    dismiss: (id: string) => {
      const index = notifications.findIndex((entry) => entry.id === id)
      if (index >= 0) notifications.splice(index, 1)
    },
  }

  beforeEach(() => notifications.splice(0))

  test('replaces progress with success while retaining the requested filename', () => {
    const feedback = createDesktopDownloadFeedback(messages, notifier)
    feedback.handle({ phase: 'started', id: 'download-1', fileName: 'character.charx' })
    expect(notifications.map((entry) => entry.message)).toEqual(['Saving character.charx'])

    // macOS cannot report the final destination, so the finished native event
    // may only carry the URL segment. Keep the name from the start event.
    feedback.handle({ phase: 'finished', id: 'download-1', fileName: 'export', success: true })
    expect(notifications.map((entry) => entry.message)).toEqual(['Saved character.charx'])
  })

  test('reports native download failures', () => {
    const feedback = createDesktopDownloadFeedback(messages, notifier)
    feedback.handle({ phase: 'started', id: 'download-2', fileName: 'pack.json' })
    feedback.handle({ phase: 'finished', id: 'download-2', fileName: 'pack.json', success: false })
    expect(notifications).toHaveLength(1)
    expect(notifications[0].type).toBe('error')
  })
})
