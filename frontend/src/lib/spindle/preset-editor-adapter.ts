import type { Preset } from '@/types/api'
import type { LoomPreset } from '@/lib/loom/types'
import { marshalUpdate, unmarshalPreset } from '@/lib/loom/service'
import type { SpindlePresetEditorDraft } from './preset-editor-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function toPresetEditorDraft(preset: LoomPreset): SpindlePresetEditorDraft {
  const raw = marshalUpdate(preset)
  return {
    id: preset.id,
    name: preset.name,
    blocks: structuredClone((raw.prompt_order ?? []) as SpindlePresetEditorDraft['blocks']),
    parameters: structuredClone(raw.parameters ?? {}),
    prompts: structuredClone(raw.prompts ?? {}),
    metadata: structuredClone(raw.metadata ?? {}),
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
  }
}

export function applyPresetEditorDraft(
  current: LoomPreset,
  draft: SpindlePresetEditorDraft,
): LoomPreset {
  if (!draft || draft.id !== current.id) throw new Error('Preset draft id cannot be changed')
  if (typeof draft.name !== 'string' || !draft.name.trim()) throw new Error('Preset name is required')
  if (!Array.isArray(draft.blocks)) throw new Error('Preset blocks must be an array')
  if (!isRecord(draft.parameters) || !isRecord(draft.prompts) || !isRecord(draft.metadata)) {
    throw new Error('Preset parameters, prompts, and metadata must be objects')
  }

  const now = Date.now()
  const raw: Preset = {
    id: current.id,
    name: draft.name.trim(),
    provider: 'loom',
    parameters: structuredClone(draft.parameters),
    prompt_order: structuredClone(draft.blocks),
    prompts: structuredClone(draft.prompts),
    metadata: structuredClone(draft.metadata),
    created_at: current.createdAt,
    updated_at: now,
  }
  const next = unmarshalPreset(raw)
  next.createdAt = current.createdAt
  next.updatedAt = now
  return next
}
