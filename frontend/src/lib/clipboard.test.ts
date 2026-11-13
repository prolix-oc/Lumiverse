import { afterEach, describe, expect, test } from 'bun:test'
import { copyTextToClipboard } from './clipboard'

const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText } },
  })
}

afterEach(() => {
  if (navigatorDescriptor) {
    Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'navigator')
  }
})

describe('copyTextToClipboard', () => {
  test('replaces the browser clipboard API generic failure with an actionable error', async () => {
    mockClipboard(async () => {
      throw new Error('The operation failed for an operation-specific reason')
    })

    await expect(copyTextToClipboard('Lumiverse')).rejects.toThrow(
      'Could not copy text to the clipboard. Check your browser clipboard permission and try again.',
    )
  })

  test('preserves useful clipboard API errors', async () => {
    mockClipboard(async () => {
      throw new Error('Clipboard access requires a user gesture')
    })

    await expect(copyTextToClipboard('Lumiverse')).rejects.toThrow('Clipboard access requires a user gesture')
  })
})
