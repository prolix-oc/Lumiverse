/// <reference types="bun-types" />

import { afterAll, describe, expect, test } from 'bun:test'

const originalImage = Object.getOwnPropertyDescriptor(globalThis, 'Image')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')

class MockImage {
  static decoded: string[] = []

  decoding = ''
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  async decode() {
    MockImage.decoded.push(this.src)
  }
}

Object.defineProperty(globalThis, 'Image', {
  configurable: true,
  value: MockImage,
})
Object.defineProperty(globalThis, 'document', {
  configurable: true,
  value: { visibilityState: 'visible' },
})

const {
  clearImageCache,
  isImageDecoded,
  prefetchImages,
  rememberImageDecoded,
} = await import('./imageDecodeCache')

afterAll(() => {
  if (originalImage) Object.defineProperty(globalThis, 'Image', originalImage)
  else delete (globalThis as any).Image

  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as any).document
})

describe('image decode coordinator', () => {
  test('retains decode metadata without requiring a retained image element', () => {
    rememberImageDecoded('/avatar.webp')
    expect(isImageDecoded('/avatar.webp')).toBe(true)

    clearImageCache()
    expect(isImageDecoded('/avatar.webp')).toBe(false)
  })

  test('predecodes a near-viewport batch and records completion', async () => {
    MockImage.decoded = []
    prefetchImages(['/one.webp', '/two.webp'])

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(MockImage.decoded).toEqual(['/one.webp', '/two.webp'])
    expect(isImageDecoded('/one.webp')).toBe(true)
    expect(isImageDecoded('/two.webp')).toBe(true)
  })
})
