import { get, del, post, upload, patch, BASE_URL } from './client'
import type { CharacterGalleryItem } from '@/types/api'

export interface BulkGallerySkippedFile {
  name: string
  reason: string
}

export interface BulkGalleryUploadResult {
  items: CharacterGalleryItem[]
  skipped: BulkGallerySkippedFile[]
}

export const characterGalleryApi = {
  list(characterId: string) {
    return get<CharacterGalleryItem[]>(`/characters/${characterId}/gallery`)
  },

  upload(characterId: string, file: File, caption?: string) {
    const form = new FormData()
    form.append('image', file)
    if (caption) form.append('caption', caption)
    return upload<CharacterGalleryItem>(`/characters/${characterId}/gallery`, form)
  },

  uploadMany(characterId: string, files: File[]) {
    const form = new FormData()
    for (const file of files) form.append('images', file)
    return upload<BulkGalleryUploadResult>(
      `/characters/${characterId}/gallery/bulk`,
      form,
      { timeout: 0 },
    )
  },

  link(characterId: string, imageId: string, caption?: string) {
    return post<CharacterGalleryItem>(`/characters/${characterId}/gallery/link`, {
      image_id: imageId,
      caption,
    })
  },

  extract(characterId: string) {
    return post<CharacterGalleryItem[]>(`/characters/${characterId}/gallery/extract`)
  },

  remove(characterId: string, itemId: string) {
    return del<void>(`/characters/${characterId}/gallery/${itemId}`)
  },

  updateCaption(characterId: string, itemId: string, caption: string) {
    return patch<CharacterGalleryItem>(`/characters/${characterId}/gallery/${itemId}`, {
      caption,
    })
  },

  imageUrl(imageId: string) {
    return `${BASE_URL}/images/${imageId}`
  },

  smallUrl(imageId: string) {
    return `${BASE_URL}/images/${imageId}?size=sm`
  },
}
