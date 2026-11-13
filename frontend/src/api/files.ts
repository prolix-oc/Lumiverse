import { get, del, upload } from './client'

export const filesApi = {
  upload(file: File, path?: string) {
    const form = new FormData()
    form.append('file', file)
    if (path) form.append('path', path)
    return upload<{ path: string; url: string }>('/files', form)
  },

  get(path: string) {
    return get<Blob>(`/files/${encodeURIComponent(path)}`)
  },

  delete(path: string) {
    return del<void>(`/files/${encodeURIComponent(path)}`)
  },
}
