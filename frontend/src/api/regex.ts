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

  create(input: CreateRegexScriptInput) {
    return post<RegexScript>('/regex-scripts', input)
  },

  update(id: string, input: UpdateRegexScriptInput) {
    return put<RegexScript>(`/regex-scripts/${id}`, input)
  },

  remove(id: string) {
    return del<void>(`/regex-scripts/${id}`)
  },

  duplicate(id: string) {
    return post<RegexScript>(`/regex-scripts/${id}/duplicate`)
  },

  toggle(id: string, disabled: boolean) {
    return put<RegexScript>(`/regex-scripts/${id}/toggle`, { disabled })
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

  importScripts(payload: any) {
    return post<{ imported: number; skipped: number; errors: string[] }>('/regex-scripts/import', payload)
  },

  testRegex(params: { find_regex: string; replace_string: string; flags: string; content: string }) {
    return post<{ result: string; matches: number; error?: string }>('/regex-scripts/test', params)
  },
}
