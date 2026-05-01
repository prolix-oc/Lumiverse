import { get, post, put, del } from './client'
import type { PaginatedResult } from '@/types/api'
import type {
  RegexScript,
  CreateRegexScriptInput,
  UpdateRegexScriptInput,
  RegexScriptExport,
  RegexTarget,
} from '@/types/regex'

export const regexApi = {
  list(params?: { limit?: number; offset?: number; scope?: string; target?: string; character_id?: string; chat_id?: string }) {
    return get<PaginatedResult<RegexScript>>('/regex-scripts', params)
  },

  get(id: string) {
    return get<RegexScript>(`/regex-scripts/${id}`)
  },

  create(input: CreateRegexScriptInput & { active_preset_id?: string | null }) {
    return post<RegexScript>('/regex-scripts', input)
  },

  activatePresetBound(presetId: string | null) {
    return post<{ changedIds: string[]; restoredIds: string[] }>('/regex-scripts/preset-activation', { preset_id: presetId })
  },

  switchPresetBound(previousPresetId: string | null, presetId: string | null) {
    return post<{ changedIds: string[]; restoredIds: string[] }>('/regex-scripts/preset-switch', {
      previous_preset_id: previousPresetId,
      preset_id: presetId,
    })
  },

  update(id: string, input: UpdateRegexScriptInput & { active_preset_id?: string | null }) {
    return put<RegexScript>(`/regex-scripts/${id}`, input)
  },

  remove(id: string) {
    return del<void>(`/regex-scripts/${id}`)
  },

  bulkRemove(ids: string[]) {
    return post<{ deleted: string[]; count: number }>('/regex-scripts/bulk-delete', { ids })
  },

  duplicate(id: string) {
    return post<RegexScript>(`/regex-scripts/${id}/duplicate`)
  },

  toggle(id: string, disabled: boolean, activePresetId?: string | null) {
    return put<RegexScript>(`/regex-scripts/${id}/toggle`, { disabled, active_preset_id: activePresetId ?? null })
  },

  reorder(ids: string[]) {
    return put<{ success: boolean }>('/regex-scripts/reorder', { ids })
  },

  getActive(params: { target: RegexTarget; character_id?: string; chat_id?: string }) {
    return get<RegexScript[]>('/regex-scripts/active', params)
  },

  exportScripts(ids?: string[]) {
    return post<RegexScriptExport>('/regex-scripts/export', { ids })
  },

  importScripts(payload: any & { active_preset_id?: string | null }) {
    return post<{ imported: number; skipped: number; errors: string[] }>('/regex-scripts/import', payload)
  },

  testRegex(params: { find_regex: string; replace_string: string; flags: string; content: string }) {
    return post<{ result: string; matches: number; error?: string }>('/regex-scripts/test', params)
  },
}
