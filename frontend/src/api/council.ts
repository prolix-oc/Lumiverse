import { get, put } from './client'
import type {
  CouncilSettings,
  CouncilToolDefinition,
} from 'lumiverse-spindle-types'

export const councilApi = {
  getSettings() {
    return get<CouncilSettings>('/council/settings')
  },

  putSettings(body: Partial<CouncilSettings>) {
    return put<CouncilSettings>('/council/settings', body)
  },

  getTools() {
    return get<CouncilToolDefinition[]>('/council/tools')
  },
}
