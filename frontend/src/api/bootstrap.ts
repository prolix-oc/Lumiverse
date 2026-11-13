import { get } from './client'
import { shareRead, sharedReadScope } from '@/lib/shared-read'
import type {
  ConnectionProfile, ProviderInfo,
  SttConnectionProfile, SttProviderInfo,
  DecisionConnectionProfile, DecisionProviderInfo,
  TtsConnectionProfile, TtsProviderInfo,
  ImageGenConnectionProfile, ImageGenProviderInfo,
  Pack, Persona, PaginatedResult, GroupedRecentChat,
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
  decision?: { connections: PaginatedResult<DecisionConnectionProfile>; providers: DecisionProviderInfo[] }
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
  /** Response-shape placeholder; `/bootstrap/landing` owns recent-chat preload. */
  recentChats: PaginatedResult<GroupedRecentChat>
}

export interface LandingBootstrapPayload {
  startupSettings: StartupSettings
  recentChats: PaginatedResult<GroupedRecentChat>
}

export interface BootstrapResponse {
  payload: BootstrapPayload
  /** Per-section failures. Missing sections arrive with empty defaults. */
  errors: Record<string, string>
}

export interface LandingBootstrapResponse {
  payload: LandingBootstrapPayload
  /** Per-section failures. Missing sections arrive with empty defaults. */
  errors: Record<string, string>
}

let landingFlight: { scope: number; request: Promise<LandingBootstrapResponse> } | null = null

export const bootstrapApi = {
  fetch: () => get<BootstrapResponse>('/bootstrap'),
  fetchLanding: () => {
    const scope = sharedReadScope()
    const request = shareRead('landing-bootstrap', () => get<LandingBootstrapResponse>('/bootstrap/landing')).then(response => {
      if (scope !== sharedReadScope()) throw new Error('Landing data changed while bootstrap was loading')
      return response
    })
    const flight = { scope, request }
    landingFlight = flight
    const release = () => { if (landingFlight === flight) landingFlight = null }
    void request.then(release, release)
    return request
  },
  pendingLanding: () => landingFlight?.scope === sharedReadScope() ? landingFlight.request : null,
}
