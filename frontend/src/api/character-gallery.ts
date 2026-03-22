import { get, del, post, upload, patch, BASE_URL } from './client'
import type { CharacterGalleryItem } from '@/types/api'

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

  thumbnailUrl(imageId: string) {
    return `${BASE_URL}/images/${imageId}?thumb=true`
  },
}
