import { get, put, del } from './client'

interface SettingRow {
  key: string
  value: any
  updated_at: number
}

export const settingsApi = {
  /** GET /settings — returns all settings as an array of { key, value, updated_at } */
  getAll() {
    return get<SettingRow[]>('/settings')
  },

  /** GET /settings/:key — get a single setting */
  get(key: string) {
    return get<SettingRow>(`/settings/${encodeURIComponent(key)}`)
  },

  /** PUT /settings/:key — upsert a single setting */
  put(key: string, value: any) {
    return put<SettingRow>(`/settings/${encodeURIComponent(key)}`, { value })
  },

  /** PUT /settings — bulk upsert, body is a flat { key: value } object */
  putMany(settings: Record<string, any>) {
    return put<SettingRow[]>('/settings', settings)
  },

  /** DELETE /settings/:key — remove a single setting */
  delete(key: string) {
    return del<{ deleted: boolean }>(`/settings/${encodeURIComponent(key)}`)
  },
}
