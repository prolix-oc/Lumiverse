import * as apiClient from './client'
import type { ComfyUICapabilities } from './image-gen'
import { generateUUID } from '@/lib/uuid'

export interface DreamWeaverAlternateField {
  id: string
  label: string
  content: string
}

export interface DreamWeaverGreeting {
  id: string
  label: string
  content: string
}

export interface DreamWeaverVoiceGuidance {
  compiled: string
  rules: {
    baseline: string[]
    rhythm: string[]
    diction: string[]
    quirks: string[]
    hard_nos: string[]
  }
}

export interface DreamWeaverLegacyImageAsset {
  id: string
  type: string
  label: string
  prompt: string
  negative: string
  imageId?: string | null
  imageUrl?: string | null
  locked?: boolean
}

export type DreamWeaverVisualProvider =
  | 'comfyui'
  | 'novelai'
  | 'nanogpt'
  | 'google_gemini'
  | 'a1111'
  | 'swarmui'

export interface DreamWeaverVisualReference {
  id: string
  image_id?: string | null
  image_url?: string | null
  weight?: number
  label?: string
}

export interface DreamWeaverVisualAsset {
  id: string
  asset_type: 'card_portrait'
  label: string
  prompt: string
  negative_prompt: string
  macro_tokens: string[]
  width: number
  height: number
  aspect_ratio: string
  seed: number | null
  references: DreamWeaverVisualReference[]
  provider: DreamWeaverVisualProvider | null
  preset_id: string | null
  provider_state: Record<string, any>
}

export type ComfyUIMappedFieldSemantic =
  | 'positive_prompt'
  | 'negative_prompt'
  | 'seed'
  | 'steps'
  | 'cfg'
  | 'sampler_name'
  | 'scheduler'
  | 'width'
  | 'height'
  | 'checkpoint'
  | 'custom'

export interface ComfyUIFieldMapping {
  nodeId: string
  fieldName: string
  mappedAs: ComfyUIMappedFieldSemantic
  autoDetected?: boolean
}

export interface ComfyUIWorkflowConfig {
  workflow_json: Record<string, any>
  workflow_api_json: Record<string, any>
  workflow_format: 'ui_workflow' | 'api_prompt'
  field_mappings: ComfyUIFieldMapping[]
  field_options?: Record<string, string[]>
  imported_at: number
  needs_reimport?: boolean
}

export interface DreamWeaverVisualJobResult {
  image_id?: string | null
  image_url?: string | null
  imageId?: string | null
  imageUrl?: string | null
  settingsSnapshot?: Record<string, unknown>
}

export interface DreamWeaverVisualJob {
  id: string
  asset_id: string
  status: 'queued' | 'running' | 'completed' | 'failed'
  progress?: Record<string, any> | null
  result?: DreamWeaverVisualJobResult | null
  error?: string | null
}

export interface DreamWeaverVisualTagSuggestion {
  suggestedTags: string
  suggestedNegativeTags: string
}

export interface PromptLayer {
  appearance: string
  composition: string
  lighting: string
  mood: string
  detail: string
  negative: string
  style: string
}

export interface ImagePromptPreset {
  id: string
  name: string
  layers: Partial<PromptLayer>
}

export interface DreamWeaverDraft {
  format: 'DW_DRAFT_V1'
  version: 1
  kind: 'character' | 'scenario'
  meta: {
    title: string
    summary: string
    tags: string[]
    content_rating: 'sfw' | 'nsfw'
  }
  card: {
    name: string
    appearance: string
    appearance_data?: Record<string, string>
    description: string
    personality: string
    scenario: string
    first_mes: string
    system_prompt: string
    post_history_instructions: string
  }
  voice_guidance: DreamWeaverVoiceGuidance
  alternate_fields: {
    description: DreamWeaverAlternateField[]
    personality: DreamWeaverAlternateField[]
    scenario: DreamWeaverAlternateField[]
  }
  greetings: DreamWeaverGreeting[]
  lorebooks: any[]
  npc_definitions: any[]
  regex_scripts: any[]
  image_assets?: DreamWeaverLegacyImageAsset[]
  visual_assets?: DreamWeaverVisualAsset[]
}

export interface DreamWeaverSession {
  id: string
  user_id: string
  created_at: number
  updated_at: number
  dream_text: string
  tone: string | null
  constraints: string | null
  dislikes: string | null
  persona_id: string | null
  connection_id: string | null
  model: string | null
  workspace_kind: 'character' | 'scenario'
  status: 'draft' | 'generating' | 'complete' | 'finalized' | 'legacy_closed' | 'error'
  character_id: string | null
  launch_chat_id: string | null
}

export interface DreamWeaverFinalizeResult {
  session: DreamWeaverSession
  characterId: string
  chatId: string | null
  alreadyFinalized: boolean
}

export interface CreateSessionInput {
  dream_text?: string
  tone?: string
  constraints?: string
  dislikes?: string
  persona_id?: string
  connection_id?: string
  model?: string
  workspace_kind?: 'character' | 'scenario'
}

export interface UpdateSessionInput {
  dream_text?: string
  tone?: string | null
  constraints?: string | null
  dislikes?: string | null
  persona_id?: string | null
  connection_id?: string | null
  model?: string | null
  workspace_kind?: 'character' | 'scenario'
}

export function createDefaultVisualAssets(): DreamWeaverVisualAsset[] {
  return [
    {
      id: 'portrait-main',
      asset_type: 'card_portrait',
      label: 'Main Portrait',
      prompt: '',
      negative_prompt: '',
      macro_tokens: [],
      width: 1024,
      height: 1024,
      aspect_ratio: '1:1',
      seed: null,
      references: [],
      provider: null,
      preset_id: null,
      provider_state: {},
    },
  ]
}

function coerceString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value == null) return ''
  if (Array.isArray(value)) {
    return value.map((entry) => coerceString(entry)).filter(Boolean).join('\n')
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return ''
    }
  }
  return String(value)
}

function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined

  const normalized: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    const nextValue = coerceString(entry).trim()
    if (nextValue) normalized[key] = nextValue
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function normalizeAltFields(value: unknown): DreamWeaverAlternateField[] {
  if (!Array.isArray(value)) return []

  return value.map((entry, index) => {
    const next = isRecord(entry) ? entry : null
    return {
      id: typeof next?.id === 'string' && next.id.trim() ? next.id : generateUUID(),
      label:
        coerceString(next?.label).trim()
          ? coerceString(next?.label).trim()
          : `Variant ${index + 1}`,
      content: coerceString(next?.content),
    }
  })
}

function normalizeGreetings(value: unknown): DreamWeaverGreeting[] {
  if (!Array.isArray(value)) return []

  return value.map((entry, index) => {
    const next = isRecord(entry) ? entry : null
    return {
      id: typeof next?.id === 'string' && next.id.trim() ? next.id : generateUUID(),
      label:
        coerceString(next?.label).trim()
          ? coerceString(next?.label).trim()
          : `Greeting ${index + 1}`,
      content: coerceString(next?.content),
    }
  })
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => coerceString(item).trim()).filter(Boolean)
}

export function normalizeDreamWeaverDraft(
  value: Partial<DreamWeaverDraft> | null | undefined,
): DreamWeaverDraft {
  const next = value ?? {}
  const meta: Record<string, any> = isRecord(next.meta) ? next.meta : {}
  const card: Record<string, any> = isRecord(next.card) ? next.card : {}
  const voice: Record<string, any> = isRecord(next.voice_guidance) ? next.voice_guidance : {}
  const rules: Record<string, any> = isRecord(voice.rules) ? voice.rules : {}
  const alternateFields: Record<string, any> = isRecord(next.alternate_fields) ? next.alternate_fields : {}
  const appearanceData = normalizeStringRecord(card.appearance_data)

  const normalizedDraft: DreamWeaverDraft = {
    format: 'DW_DRAFT_V1',
    version: 1,
    kind: next.kind === 'scenario' ? 'scenario' : 'character',
    meta: {
      title: coerceString(meta.title),
      summary: coerceString(meta.summary),
      tags: normalizeStringArray(meta.tags),
      content_rating: meta.content_rating === 'nsfw' ? 'nsfw' : 'sfw',
    },
    card: {
      name: coerceString(card.name),
      appearance: coerceString(card.appearance),
      appearance_data: appearanceData,
      description: coerceString(card.description),
      personality: coerceString(card.personality),
      scenario: coerceString(card.scenario),
      first_mes: coerceString(card.first_mes),
      system_prompt: coerceString(card.system_prompt),
      post_history_instructions:
        coerceString(card.post_history_instructions),
    },
    voice_guidance: {
      compiled: coerceString(voice.compiled),
      rules: {
        baseline: normalizeStringArray(rules.baseline),
        rhythm: normalizeStringArray(rules.rhythm),
        diction: normalizeStringArray(rules.diction),
        quirks: normalizeStringArray(rules.quirks),
        hard_nos: normalizeStringArray(rules.hard_nos),
      },
    },
    alternate_fields: {
      description: normalizeAltFields(alternateFields.description),
      personality: normalizeAltFields(alternateFields.personality),
      scenario: normalizeAltFields(alternateFields.scenario),
    },
    greetings: normalizeGreetings(next.greetings),
    lorebooks: Array.isArray(next.lorebooks) ? next.lorebooks : [],
    npc_definitions: Array.isArray(next.npc_definitions) ? next.npc_definitions : [],
    regex_scripts: Array.isArray(next.regex_scripts) ? next.regex_scripts : [],
    image_assets: Array.isArray(next.image_assets) ? next.image_assets : [],
    visual_assets: normalizeDraftVisualAssets(next),
  }

  return syncDraftVisualAssets(normalizedDraft) as DreamWeaverDraft
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isVisualProvider(value: unknown): value is DreamWeaverVisualProvider {
  return (
    value === 'comfyui' ||
    value === 'novelai' ||
    value === 'nanogpt' ||
    value === 'google_gemini' ||
    value === 'a1111' ||
    value === 'swarmui'
  )
}

function normalizeVisualReferences(value: unknown): DreamWeaverVisualReference[] {
  if (!Array.isArray(value)) return []

  const references: DreamWeaverVisualReference[] = []
  for (const reference of value) {
    if (!isRecord(reference)) continue
    if (typeof reference.id !== 'string' || !reference.id.trim()) continue
    references.push({
      id: reference.id,
      image_id:
        typeof reference.image_id === 'string' && reference.image_id.trim()
          ? reference.image_id
          : undefined,
      image_url:
        typeof reference.image_url === 'string' && reference.image_url.trim()
          ? reference.image_url
          : undefined,
      weight: typeof reference.weight === 'number' ? reference.weight : undefined,
      label:
        typeof reference.label === 'string' && reference.label.trim() ? reference.label : undefined,
    })
  }
  return references
}

function normalizeVisualAsset(value: unknown): DreamWeaverVisualAsset | null {
  if (!isRecord(value) || value.asset_type !== 'card_portrait') return null

  return {
    ...value,
    id: typeof value.id === 'string' && value.id.trim() ? value.id : 'portrait-main',
    asset_type: 'card_portrait',
    label: typeof value.label === 'string' && value.label.trim() ? value.label : 'Main Portrait',
    prompt: typeof value.prompt === 'string' ? value.prompt : '',
    negative_prompt: typeof value.negative_prompt === 'string' ? value.negative_prompt : '',
    macro_tokens: Array.isArray(value.macro_tokens)
      ? value.macro_tokens.filter((token: unknown) => typeof token === 'string')
      : [],
    width: Number.isFinite(value.width) ? Number(value.width) : 1024,
    height: Number.isFinite(value.height) ? Number(value.height) : 1024,
    aspect_ratio:
      typeof value.aspect_ratio === 'string' && value.aspect_ratio.trim()
        ? value.aspect_ratio
        : '1:1',
    seed:
      value.seed == null
        ? null
        : Number.isFinite(value.seed)
          ? Number(value.seed)
          : null,
    references: normalizeVisualReferences(value.references),
    provider: isVisualProvider(value.provider) ? value.provider : null,
    preset_id: typeof value.preset_id === 'string' ? value.preset_id : null,
    provider_state: isRecord(value.provider_state) ? value.provider_state : {},
  }
}

function legacyAssetToVisualAsset(asset: DreamWeaverLegacyImageAsset): DreamWeaverVisualAsset {
  const imageId = typeof asset.imageId === 'string' && asset.imageId.trim() ? asset.imageId : undefined
  const imageUrl =
    typeof asset.imageUrl === 'string' && asset.imageUrl.trim() ? asset.imageUrl : undefined

  return {
    id: asset.id,
    asset_type: 'card_portrait',
    label: asset.label || 'Main Portrait',
    prompt: asset.prompt || '',
    negative_prompt: asset.negative || '',
    macro_tokens: [],
    width: 1024,
    height: 1024,
    aspect_ratio: '1:1',
    seed: null,
    references:
      imageId || imageUrl
        ? [{ id: `${asset.id}-ref`, image_id: imageId, image_url: imageUrl }]
        : [],
    provider: null,
    preset_id: null,
    provider_state: {},
  }
}

function mergeLegacyIntoVisualAssets(
  visualAssets: DreamWeaverVisualAsset[],
  legacyAssets: DreamWeaverLegacyImageAsset[],
): DreamWeaverVisualAsset[] {
  if (!legacyAssets.length) return visualAssets

  const visualById = new Map(visualAssets.map((asset) => [asset.id, asset]))
  const mergedAssets = legacyAssets.map((legacyAsset) => {
    const existingVisual = visualById.get(legacyAsset.id)
    if (!existingVisual) {
      return legacyAssetToVisualAsset(legacyAsset)
    }

    visualById.delete(legacyAsset.id)
    return {
      ...existingVisual,
      label: typeof legacyAsset.label === 'string' && legacyAsset.label.trim()
        ? legacyAsset.label
        : existingVisual.label,
    }
  })

  return [...mergedAssets, ...visualById.values()]
}

export function normalizeDraftVisualAssets(
  draft: Partial<DreamWeaverDraft> | null | undefined,
): DreamWeaverVisualAsset[] {
  if (Array.isArray(draft?.visual_assets) && draft.visual_assets.length > 0) {
    const normalizedVisualAssets = draft.visual_assets
      .map((asset) => normalizeVisualAsset(asset))
      .filter((asset): asset is DreamWeaverVisualAsset => Boolean(asset))

    if (normalizedVisualAssets.length > 0) {
      return normalizedVisualAssets
    }
  }

  if (Array.isArray(draft?.image_assets) && draft.image_assets.length > 0) {
    return draft.image_assets.map(legacyAssetToVisualAsset)
  }

  return createDefaultVisualAssets()
}

export function syncDraftVisualAssets(draft: DreamWeaverDraft): DreamWeaverDraft
export function syncDraftVisualAssets(
  visualAssets: DreamWeaverVisualAsset[],
  legacyAssets: DreamWeaverLegacyImageAsset[],
): DreamWeaverVisualAsset[]
export function syncDraftVisualAssets(
  input: DreamWeaverDraft | DreamWeaverVisualAsset[],
  legacyInputAssets: DreamWeaverLegacyImageAsset[] = [],
): DreamWeaverDraft | DreamWeaverVisualAsset[] {
  if (Array.isArray(input)) {
    return mergeLegacyIntoVisualAssets(input, legacyInputAssets)
  }

  const visualAssets = mergeLegacyIntoVisualAssets(
    normalizeDraftVisualAssets(input),
    input.image_assets ?? [],
  )
  const syncedLegacyAssets: DreamWeaverLegacyImageAsset[] = visualAssets.map((asset) => ({
    id: asset.id,
    type: 'portrait',
    label: asset.label,
    prompt: asset.prompt,
    negative: asset.negative_prompt,
    imageId: asset.references[0]?.image_id ?? null,
    imageUrl: asset.references[0]?.image_url ?? null,
    locked: false,
  }))

  return {
    ...input,
    visual_assets: visualAssets,
    image_assets: syncedLegacyAssets,
  }
}

export const dreamWeaverApi = {
  createSession: (input: CreateSessionInput) =>
    apiClient.post<DreamWeaverSession>('/dream-weaver/sessions', input),

  getSessions: () =>
    apiClient.get<DreamWeaverSession[]>('/dream-weaver/sessions'),

  getSession: (id: string) =>
    apiClient.get<DreamWeaverSession>(`/dream-weaver/sessions/${id}`),

  updateSession: (id: string, input: UpdateSessionInput) =>
    apiClient.put<DreamWeaverSession>(`/dream-weaver/sessions/${id}`, input),

  finalize: (id: string) =>
    apiClient.post<DreamWeaverFinalizeResult>(`/dream-weaver/sessions/${id}/finalize`, {}),

  deleteSession: (id: string) =>
    apiClient.del(`/dream-weaver/sessions/${id}`),

  importComfyUIWorkflow: (connectionId: string, workflow: unknown) =>
    apiClient.post<{ config: ComfyUIWorkflowConfig }>(
      '/dream-weaver/visual/workflows/import',
      { connectionId, workflow },
    ),

  updateComfyUIWorkflowMappings: (connectionId: string, mappings: ComfyUIFieldMapping[]) =>
    apiClient.put<{ config: ComfyUIWorkflowConfig }>(
      `/dream-weaver/visual/workflows/${connectionId}/mappings`,
      { mappings },
    ),

  getComfyUIWorkflowConfig: (connectionId: string) =>
    apiClient.get<{ config: ComfyUIWorkflowConfig | null }>(
      `/dream-weaver/visual/workflows/${connectionId}`,
    ),

  getComfyUICapabilities: async (connectionId: string, forceRefresh = false) => {
    const query = forceRefresh ? '?refresh=1' : ''
    const response = await apiClient.get<{ capabilities: ComfyUICapabilities }>(
      `/dream-weaver/visual/comfyui/${connectionId}/capabilities${query}`,
    )
    return response.capabilities
  },

  suggestVisualTags: (
    sessionId: string,
    draft?: DreamWeaverDraft | null,
    options?: { timeoutMs?: number | null },
  ) => {
    // Mirror the user's Dream Weaver timeout setting onto the HTTP client so
    // the browser doesn't abort at the default 30s while the backend is still
    // waiting on the LLM. When the user picks a value, add a small buffer
    // over the backend timeout so the backend's nicer error wins the race.
    // `null` (None) disables the frontend timeout entirely.
    let requestOptions: { timeout: number } | undefined
    if (options && 'timeoutMs' in options) {
      const ms = options.timeoutMs
      requestOptions = { timeout: ms == null || ms <= 0 ? 0 : ms + 5_000 }
    }
    return apiClient.post<DreamWeaverVisualTagSuggestion>(
      '/dream-weaver/visual/tag-suggestions',
      { sessionId, draft },
      requestOptions,
    )
  },

  startVisualJob: (sessionId: string, asset: DreamWeaverVisualAsset, connectionId: string) =>
    apiClient.post<DreamWeaverVisualJob>(
      '/dream-weaver/visual/jobs',
      { sessionId, asset, connectionId },
    ),

  getVisualJob: (jobId: string) =>
    apiClient.get<DreamWeaverVisualJob>(`/dream-weaver/visual/jobs/${jobId}`),
}
