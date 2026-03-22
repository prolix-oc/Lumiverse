import { get, post } from './client'

export interface MacroResolveRequest {
  template: string
  chat_id?: string
  character_id?: string
  persona_id?: string
  connection_id?: string
  dynamic_macros?: Record<string, string>
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

export function resolveMacros(req: MacroResolveRequest): Promise<MacroResolveResponse> {
  return post('/macros/resolve', req)
}

export function getMacroCatalog(): Promise<MacroCatalogResponse> {
  return get('/macros')
}
