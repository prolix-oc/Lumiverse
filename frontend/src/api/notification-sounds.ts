import { del, upload, BASE_URL } from './client'

export interface CompletionSoundMetadata {
  filename: string
  mimeType: string
  byteSize: number
  uploadedAt: number
}

export const notificationSoundsApi = {
  uploadCompletion(file: File) {
    const form = new FormData()
    form.append('sound', file)
    return upload<CompletionSoundMetadata & { extension: string }>(
      '/notification-sounds/completion',
      form,
    )
  },

  deleteCompletion() {
    return del<{ success: true }>('/notification-sounds/completion')
  },

  completionUrl(version: number) {
    return `${BASE_URL}/notification-sounds/completion?v=${version}`
  },
}
