import { get, put, del, post } from './client'

export const secretsApi = {
  list() {
    return get<string[]>('/secrets')
  },

  get(key: string) {
    return get<{ value: string }>(`/secrets/${key}`)
  },

  put(key: string, value: string) {
    return put<void>(`/secrets/${key}`, { value })
  },

  delete(key: string) {
    return del<void>(`/secrets/${key}`)
  },

  validate(key: string) {
    return post<{ valid: boolean }>(`/secrets/${key}/validate`)
  },
}
