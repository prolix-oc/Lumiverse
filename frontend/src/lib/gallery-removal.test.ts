import { expect, mock, test } from 'bun:test'
import { completeGalleryRemoval } from './gallery-removal'
import { isGalleryItemRemoved, isImageDeleted, notifyGalleryItemRemoved, onGalleryItemRemoved, type GalleryItemRemoved } from './deletion-events'

const item = (): GalleryItemRemoved => ({ id: crypto.randomUUID(), characterId: crypto.randomUUID(), imageId: crypto.randomUUID(), status: 'completed' })

test('a committed gallery event resolves before slow HTTP cleanup and leaves shared images visible', async () => {
  const removed = item()
  const response = Promise.withResolvers<GalleryItemRemoved>()
  const readStatus = mock(async () => ({ deleted: false }))
  let settled = false
  const pending = completeGalleryRemoval({ characterId: removed.characterId, itemId: removed.id, request: () => response.promise, readStatus }).then(() => { settled = true })
  notifyGalleryItemRemoved({ ...removed, characterId: 'another-character' })
  await Promise.resolve()
  expect(settled).toBe(false)
  notifyGalleryItemRemoved(removed)
  await pending
  expect(readStatus).not.toHaveBeenCalled()
  expect(isGalleryItemRemoved(removed.characterId, removed.id)).toBe(true)
  expect(isImageDeleted(removed.imageId!)).toBe(false)
  response.reject(new Error('later cleanup response lost'))
  await Promise.resolve()
})

test('a missed event is reconciled from gallery membership while the HTTP request is still pending', async () => {
  const removed = item()
  const response = Promise.withResolvers<GalleryItemRemoved>()
  const readStatus = mock(async () => ({ deleted: true }))
  await completeGalleryRemoval({ characterId: removed.characterId, itemId: removed.id, request: () => response.promise, readStatus, pollMs: 2 })
  expect(readStatus).toHaveBeenCalledTimes(1)
  expect(isGalleryItemRemoved(removed.characterId, removed.id)).toBe(true)
  response.resolve(removed)
})

test('duplicate HTTP and event confirmations remove only the targeted gallery entry once', async () => {
  const removed = item()
  const listener = mock(() => {})
  const stop = onGalleryItemRemoved(listener)
  try {
    await completeGalleryRemoval({ characterId: removed.characterId, itemId: removed.id, request: async () => removed, readStatus: async () => ({ deleted: false }) })
    notifyGalleryItemRemoved(removed)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(isGalleryItemRemoved(removed.characterId, 'another-entry')).toBe(false)
  } finally { stop() }
})

test('a failed request with a surviving row rejects and a timeout never assumes deletion', async () => {
  const removed = item()
  await expect(completeGalleryRemoval({ characterId: removed.characterId, itemId: removed.id, request: async () => { throw new Error('delete failed') }, readStatus: async () => ({ deleted: false }) })).rejects.toThrow('delete failed')
  const response = Promise.withResolvers<GalleryItemRemoved>()
  await expect(completeGalleryRemoval({ characterId: removed.characterId, itemId: removed.id, request: () => response.promise, readStatus: async () => ({ deleted: false }), pollMs: 2, timeoutMs: 10 })).rejects.toThrow('unconfirmed')
  expect(isGalleryItemRemoved(removed.characterId, removed.id)).toBe(false)
  response.reject(new Error('request expired'))
})
