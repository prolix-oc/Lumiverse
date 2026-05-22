import { get } from './client'
import type {
  ConnectionProfile, ProviderInfo,
  SttConnectionProfile, SttProviderInfo,
  TtsConnectionProfile, TtsProviderInfo,
  ImageGenConnectionProfile, ImageGenProviderInfo,
  Pack, Persona, PaginatedResult,
} from '@/types/api'
import type { RegexScript } from '@/types/regex'
import type { StartupSettings } from '@/types/store'
import type { CouncilSettings, CouncilToolDefinition, ExtensionInfo, ToolRegistration } from 'lumiverse-spindle-types'

/**
 * Single aggregated payload from `GET /api/v1/bootstrap`. Each field mirrors
 * the shape of its corresponding per-endpoint response so `useAppInit` can
 * fan the result straight into the existing store setters.
 */
export interface BootstrapPayload {
  startupSettings: StartupSettings
  llm: {
    connections: PaginatedResult<ConnectionProfile>
    providers: ProviderInfo[]
  }
  stt: {
    connections: PaginatedResult<SttConnectionProfile>
    providers: SttProviderInfo[]
  }
  tts: {
    connections: PaginatedResult<TtsConnectionProfile>
    providers: TtsProviderInfo[]
  }
  imageGen: {
    connections: PaginatedResult<ImageGenConnectionProfile>
    providers: ImageGenProviderInfo[]
  }
  packs: PaginatedResult<Pack>
  personas: PaginatedResult<Persona>
  regexScripts: PaginatedResult<RegexScript>
  council: {
    settings: CouncilSettings
    tools: CouncilToolDefinition[]
  }
  spindle: {
    extensions: Array<ExtensionInfo & { status: string }>
    isPrivileged: boolean
    tools: ToolRegistration[]
  }
}

export interface BootstrapResponse {
  payload: BootstrapPayload
  /** Per-section failures. Missing sections arrive with empty defaults. */
  errors: Record<string, string>
}

export const bootstrapApi = {
  fetch: () => get<BootstrapResponse>('/bootstrap'),
}
