import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { CharacterGalleryItem, Image } from '@/types/api'

const upload = mock(async (_file: File, onProgress?: (percent: number) => void) => {
  onProgress?.(50)
  onProgress?.(100)
  return { id: 'crop-image' } as Image
})
mock.module('@/api/images', () => ({ imagesApi: { upload } }))
const { uploadAlternateAvatar } = await import('./alternateAvatarUpload')

const crop = new File(['crop'], 'avatar.png', { type: 'image/png' })
const galleryItem = { image_id: 'gallery-original', caption: '  Winter outfit  ' } as CharacterGalleryItem

beforeEach(() => { upload.mockClear() })

describe('alternate avatar uploads', () => {
  test('uploads only the crop and keeps the gallery original and caption', async () => {
    const progress = mock((_percent: number) => {})
    const avatar = await uploadAlternateAvatar(crop, galleryItem, 'New Avatar', progress)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0]).toBe(crop)
    expect(avatar).toMatchObject({ image_id: 'crop-image', original_image_id: 'gallery-original', label: 'Winter outfit' })
    expect(avatar.id).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
    expect(progress.mock.calls.map((args) => args[0])).toEqual([50, 100])
  })

  test('uses the localized default when the gallery caption is blank', async () => {
    const avatar = await uploadAlternateAvatar(crop, { ...galleryItem, caption: '  ' }, 'Neuer Avatar', () => {})
    expect(avatar.label).toBe('Neuer Avatar')
  })

  test('local uploads still save both the full original and crop', async () => {
    const original = new File(['original'], 'full.png', { type: 'image/png' })
    upload.mockImplementationOnce(async (_file, onProgress) => {
      onProgress?.(50)
      onProgress?.(100)
      return { id: 'local-original' } as Image
    })
    const progress = mock((_percent: number) => {})
    const avatar = await uploadAlternateAvatar(crop, original, 'New Avatar', progress)
    expect(upload.mock.calls.map((args) => args[0])).toEqual([original, crop])
    expect(avatar).toMatchObject({ image_id: 'crop-image', original_image_id: 'local-original', label: 'New Avatar' })
    expect(progress.mock.calls.map((args) => args[0])).toEqual([20, 40, 70, 100])
  })

  test('does not produce an avatar entry if the crop upload fails', async () => {
    upload.mockRejectedValueOnce(new Error('Upload failed'))
    await expect(uploadAlternateAvatar(crop, galleryItem, 'New Avatar', () => {})).rejects.toThrow('Upload failed')
  })
})
