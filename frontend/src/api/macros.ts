import { get, post } from './client'
import { flushSettingsNow } from '@/store/slices/settings'
import type { PromptBlock, PromptVariableValues } from '@/lib/loom/types'

export interface MacroResolveRequest {
  template: string
  chat_id?: string
  character_id?: string
  persona_id?: string
  connection_id?: string
  dynamic_macros?: Record<string, string>
  prompt_blocks?: PromptBlock[]
  prompt_variables?: PromptVariableValues
  /**
   * Strip leading/trailing whitespace from the resolved text, mirroring the
   * per-block trim the prompt assembly applies. Used by the block-editor
   * preview so it matches a dry run. Leave unset for free-form resolution
   * (e.g. resolving the chat input) where the caller's whitespace matters.
   */
  trim?: boolean
}

export interface MacroResolveResponse {
  text: string
  diagnostics: { level: string; message: string; macroName?: string }[]
}

export interface MacroCatalogEntry {
  name: string
  syntax: string
  description: string
  args?: { name: string; optional?: boolean }[]
  returns?: string
  category: string
}

export interface MacroCatalogResponse {
  categories: { category: string; macros: MacroCatalogEntry[] }[]
}

export interface MacroBatchResolveRequest {
  templates: Record<string, string>
  chat_id?: string
  character_id?: string
  persona_id?: string
  connection_id?: string
  prompt_blocks?: PromptBlock[]
  prompt_variables?: PromptVariableValues
}

export interface MacroBatchResolveResponse {
  resolved: Record<string, string>
}

export async function resolveMacros(req: MacroResolveRequest): Promise<MacroResolveResponse> {
  await flushSettingsNow()
  return post('/macros/resolve', req)
}

export async function resolveMacrosBatch(req: MacroBatchResolveRequest): Promise<MacroBatchResolveResponse> {
  await flushSettingsNow()
  return post('/macros/resolve-batch', req)
}

export function getMacroCatalog(): Promise<MacroCatalogResponse> {
  return get('/macros')
}
