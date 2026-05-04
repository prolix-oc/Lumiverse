import type {
  ComfyUIWorkflowConfig,
  DreamWeaverDraft,
  DreamWeaverVisualAsset,
  DreamWeaverVisualJob,
  DreamWeaverVisualProvider,
  DreamWeaverVisualReference,
} from '@/api/dream-weaver'
import { BASE_URL } from '@/api/client'
import { imagesApi } from '@/api/images'
import { hasComfyRequiredPromptMappings } from '../visual-studio/comfyui/mapped-fields'

export type VisualWorkspaceKind = 'comfyui' | 'simple' | 'none'
export type VisualAssetHintState = 'active' | 'muted'
export type VisualWorkspaceState =
  | 'no_source'
  | 'needs_workflow'
  | 'needs_mapping'
  | 'ready'
  | 'generating'
  | 'candidate_ready'
  | 'failed'

const LABELS: Record<string, string> = {
  comfyui: 'ComfyUI',
  novelai: 'NovelAI',
  nanogpt: 'Nano-GPT',
  google_gemini: 'Google Gemini',
  a1111: 'AUTOMATIC1111',
  swarmui: 'SwarmUI',
}

export interface VisualStudioAssetSummary {
  totalAssets: number
  generatedAssets: number
  pendingAssets: number
  primaryLabel: string
}

export interface VisualAssetHintItem {
  id: 'portrait' | 'expressions' | 'gallery'
  label: string
  state: VisualAssetHintState
}

export interface DreamWeaverVisualMacroOption {
  token: string
  label: string
  value: string
  group: 'soul' | 'appearance_data'
}

export interface VisualJobImageReference {
  image_id?: string | null
  image_url?: string | null
}

export function getVisualAssetHintItems(): VisualAssetHintItem[] {
  return [
    { id: 'portrait', label: 'Portrait', state: 'active' },
    { id: 'expressions', label: 'Expressions', state: 'muted' },
    { id: 'gallery', label: 'Gallery', state: 'muted' },
  ]
}

export function getProviderWorkspaceKind(
  provider: DreamWeaverVisualProvider | null | undefined,
): VisualWorkspaceKind {
  if (!provider) return 'none'
  if (provider === 'comfyui') return 'comfyui'
  if (provider === 'a1111') return 'none'
  return 'simple'
}

export function collectPromptMacroTokens(prompt: string): string[] {
  const tokens = new Set<string>()
  for (const match of prompt.matchAll(/\{\{([\w.]+)\}\}/g)) {
    const tokenName = match[1]?.trim()
    if (!tokenName) continue
    tokens.add(`{{${tokenName}}}`)
  }
  return [...tokens]
}

type VisualJobResultLike =
  | Pick<DreamWeaverVisualJob, 'result'>
  | DreamWeaverVisualJob['result']
  | null
  | undefined

function getVisualJobResult(input: VisualJobResultLike): Record<string, unknown> | null {
  if (!input || typeof input !== 'object') return null
  const maybeJob = input as { result?: unknown }
  if ('result' in maybeJob) {
    return maybeJob.result && typeof maybeJob.result === 'object'
      ? (maybeJob.result as Record<string, unknown>)
      : null
  }
  return input as Record<string, unknown>
}

function getText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function resolveSafeVisualImageUrl(value: unknown): string | null {
  const raw = getText(value)
  if (!raw) return null
  if (raw.startsWith('data:image/') || raw.startsWith('blob:')) return raw

  const browserOrigin = typeof window !== 'undefined' ? window.location.origin : null
  if (!browserOrigin) return raw.startsWith('/') ? raw : null

  try {
    const url = new URL(raw, browserOrigin)
    const apiOrigin = new URL(BASE_URL, browserOrigin).origin
    if (url.origin === browserOrigin || url.origin === apiOrigin) return raw
  } catch {
    return null
  }

  return null
}

export function resolveVisualJobImageUrl(input: VisualJobResultLike): string | null {
  const result = getVisualJobResult(input)
  if (!result) return null
  const imageId = getText(result.image_id) ?? getText(result.imageId)
  if (imageId) return imagesApi.url(imageId)
  return resolveSafeVisualImageUrl(result.image_url) ?? resolveSafeVisualImageUrl(result.imageUrl)
}

export function resolveVisualJobImageReference(input: VisualJobResultLike): VisualJobImageReference | null {
  const result = getVisualJobResult(input)
  if (!result) return null

  const imageId = getText(result.image_id) ?? getText(result.imageId)
  const imageUrl = resolveSafeVisualImageUrl(result.image_url) ?? resolveSafeVisualImageUrl(result.imageUrl)

  if (!imageId && !imageUrl) return null
  return {
    image_id: imageId ?? undefined,
    image_url: imageUrl ?? undefined,
  }
}

export function resolveVisualReferenceImageUrl(
  reference: Pick<DreamWeaverVisualReference, 'image_url' | 'image_id'> | null | undefined,
): string | null {
  const imageId = getText(reference?.image_id)
  if (imageId) return imagesApi.url(imageId)
  return resolveSafeVisualImageUrl(reference?.image_url)
}

export function getVisualWorkspaceState(input: {
  provider: DreamWeaverVisualProvider | null | undefined
  workflowConfig?: ComfyUIWorkflowConfig | null
  job?: Pick<DreamWeaverVisualJob, 'status' | 'result'> | null | undefined
  candidateImageUrl?: string | null
}): VisualWorkspaceState {
  if (!input.provider) return 'no_source'

  const jobStatus = input.job?.status
  if (jobStatus === 'failed') return 'failed'
  if (jobStatus === 'queued' || jobStatus === 'running') return 'generating'

  const candidateImageUrl = input.candidateImageUrl ?? resolveVisualJobImageUrl(input.job)
  if (candidateImageUrl) return 'candidate_ready'

  if (input.provider === 'comfyui' && !input.workflowConfig) {
    return 'needs_workflow'
  }
  if (
    input.provider === 'comfyui' &&
    !hasComfyRequiredPromptMappings(input.workflowConfig)
  ) {
    return 'needs_mapping'
  }

  return 'ready'
}

export function resolveSelectedImageConnectionId(
  selectedConnectionId: string | null | undefined,
  connections: Array<{ id: string; is_default?: boolean | null }>,
): string | null {
  if (
    selectedConnectionId &&
    connections.some((connection) => connection.id === selectedConnectionId)
  ) {
    return selectedConnectionId
  }

  const defaultConnection = connections.find((connection) => connection.is_default)
  return defaultConnection?.id ?? null
}

export function buildVisualMacroOptions(
  draft: DreamWeaverDraft | null | undefined,
): DreamWeaverVisualMacroOption[] {
  if (!draft) return []

  const options: DreamWeaverVisualMacroOption[] = []
  const pushOption = (
    tokenName: string,
    label: string,
    value: unknown,
    group: DreamWeaverVisualMacroOption['group'],
  ) => {
    const trimmed = typeof value === 'string'
      ? value.trim()
      : String(value ?? '').trim()
    if (!trimmed) return
    options.push({
      token: `{{${tokenName}}}`,
      label,
      value: trimmed,
      group,
    })
  }

  pushOption('name', 'Name', draft.card.name, 'soul')
  pushOption('appearance', 'Appearance', draft.card.appearance, 'soul')
  pushOption('description', 'Description', draft.card.description, 'soul')
  pushOption('personality', 'Personality', draft.card.personality, 'soul')
  pushOption('scenario', 'Scenario', draft.card.scenario, 'soul')

  for (const [key, value] of Object.entries(draft.card.appearance_data ?? {})) {
    pushOption(`appearance.${key}`, key, value, 'appearance_data')
  }

  return options
}

export function resolveVisualPrompt(
  prompt: string,
  values: Record<string, string | undefined>,
): string {
  return prompt.replace(/\{\{([\w.]+)\}\}/g, (fullMatch, tokenName: string) => {
    const normalized = tokenName.trim()
    if (!normalized) return fullMatch
    const value = values[normalized]
    return typeof value === 'string' ? value : fullMatch
  })
}

function trimPromptSeparators(prompt: string): string {
  return prompt
    .replace(/\s*,\s*,+/g, ', ')
    .replace(/^\s*,\s*/, '')
    .replace(/\s*,\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export function getLastSuggestedTags(
  asset: Pick<DreamWeaverVisualAsset, 'provider_state'> | null | undefined,
): string | null {
  const value = asset?.provider_state?.tag_suggester?.lastSuggestedTags
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function applySuggestedTagsToPrompt(
  prompt: string,
  nextSuggestedTags: string,
  previousSuggestedTags?: string | null,
): string {
  const previous = previousSuggestedTags?.trim()
  let nextPrompt = prompt

  if (previous) {
    const index = nextPrompt.lastIndexOf(previous)
    if (index >= 0) {
      nextPrompt = `${nextPrompt.slice(0, index)}${nextPrompt.slice(index + previous.length)}`
    }
  }

  const trimmedBase = trimPromptSeparators(nextPrompt)
  const trimmedNext = nextSuggestedTags.trim()
  if (!trimmedNext) return trimmedBase
  if (!trimmedBase) return trimmedNext
  return `${trimmedBase}, ${trimmedNext}`
}

export function getVisualStudioLabel(
  value: DreamWeaverVisualProvider | null | undefined,
): string {
  if (!value) return 'Unassigned'
  return LABELS[value] ?? String(value)
}

export function getVisualStudioAssetSummary(
  assets: Array<Pick<DreamWeaverVisualAsset, 'label' | 'references'>>,
): VisualStudioAssetSummary {
  const generatedAssets = assets.filter((asset) =>
    asset.references.some((reference) => Boolean(reference.image_id || reference.image_url)),
  ).length

  return {
    totalAssets: assets.length,
    generatedAssets,
    pendingAssets: Math.max(assets.length - generatedAssets, 0),
    primaryLabel: assets[0]?.label?.trim() || 'Main Portrait',
  }
}
