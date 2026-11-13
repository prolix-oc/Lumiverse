import { get, post } from './client'
import type { LumiFileFormat, Preset } from '@/types/api'

export const lumiApi = {
  importLumiFile(data: any) {
    return post<Preset>('/lumi/import', data)
  },

  exportLumiFile(presetId: string) {
    return get<LumiFileFormat>(`/lumi/export/${presetId}`)
  },
}
