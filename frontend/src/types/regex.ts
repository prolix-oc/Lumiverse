export type RegexPlacement = 'user_input' | 'ai_output' | 'world_info' | 'reasoning'
export type RegexScope = 'global' | 'character' | 'chat'
export type RegexTarget = 'prompt' | 'response' | 'display'
export type RegexMacroMode = 'none' | 'raw' | 'escaped'

export interface RegexPerformanceMetadata {
  slow: boolean
  timed_out: boolean
  elapsed_ms: number
  threshold_ms: number
  detected_at: number
  source: 'prompt_backend' | 'response_backend' | 'display_backend' | 'display_client'
  version: number
}

export interface RegexScript {
  id: string
  user_id: string
  name: string
  script_id: string
  find_regex: string
  replace_string: string
  flags: string
  placement: RegexPlacement[]
  scope: RegexScope
  scope_id: string | null
  target: RegexTarget
  min_depth: number | null
  max_depth: number | null
  trim_strings: string[]
  run_on_edit: boolean
  substitute_macros: RegexMacroMode
  disabled: boolean
  sort_order: number
  description: string
  folder: string
  pack_id?: string | null
  preset_id?: string | null
  metadata: Record<string, any>
  created_at: number
  updated_at: number
}

export interface CreateRegexScriptInput {
  name: string
  find_regex: string
  script_id?: string
  replace_string?: string
  flags?: string
  placement?: RegexPlacement[]
  scope?: RegexScope
  scope_id?: string | null
  target?: RegexTarget
  min_depth?: number | null
  max_depth?: number | null
  trim_strings?: string[]
  run_on_edit?: boolean
  substitute_macros?: RegexMacroMode
  disabled?: boolean
  sort_order?: number
  description?: string
  folder?: string
  preset_id?: string | null
  character_id?: string | null
  metadata?: Record<string, any>
}

export type UpdateRegexScriptInput = Partial<CreateRegexScriptInput>

export interface RegexScriptExport {
  version: 1
  type: 'lumiverse_regex_scripts'
  scripts: Array<Omit<RegexScript, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
  exported_at: number
}
