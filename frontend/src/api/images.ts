import { get, del, upload, BASE_URL } from './client'
import type { Image } from '@/types/api'

export const imagesApi = {
  get(id: string) {
    return get<Image>(`/images/${id}`)
  },

  upload(file: File) {
    const form = new FormData()
    form.append('image', file)
    return upload<Image>('/images', form)
  },

  delete(id: string) {
    return del<void>(`/images/${id}`)
  },

  url(id: string) {
    return `${BASE_URL}/images/${id}`
  },

  thumbnailUrl(id: string) {
    return `${BASE_URL}/images/${id}?thumb=true`
  },
}
