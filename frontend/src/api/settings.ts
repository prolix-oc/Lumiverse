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

  /** PUT /settings/saved-themes — allows theme packs with embedded assets. */
  putSavedThemes(value: any) {
    // A saved theme pack may contain base64-encoded fonts and images, so its
    // upload can legitimately take longer than the normal API timeout.
    return put<SettingRow>('/settings/saved-themes', { value }, { timeout: 0 })
  },

  /** PUT /settings — bulk upsert, body is a flat { key: value } object */
  putMany(settings: Record<string, any>) {
    const hasSavedThemes = Object.prototype.hasOwnProperty.call(settings, 'savedThemes')
    const { savedThemes, ...otherSettings } = settings
    const writes: Array<Promise<SettingRow[]>> = []

    if (Object.keys(otherSettings).length > 0) {
      writes.push(put<SettingRow[]>('/settings', otherSettings))
    }
    if (hasSavedThemes) {
      writes.push(this.putSavedThemes(savedThemes).then((setting) => [setting]))
    }

    return Promise.all(writes).then((results) => results.flat())
  },

  /** DELETE /settings/:key — remove a single setting */
  delete(key: string) {
    return del<{ deleted: boolean }>(`/settings/${encodeURIComponent(key)}`)
  },
}
