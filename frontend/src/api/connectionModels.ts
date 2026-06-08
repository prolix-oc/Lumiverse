import { connectionsApi } from '@/api/connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { sttConnectionsApi } from '@/api/stt-connections'

export type ConnectionKind = 'llm' | 'imageGen' | 'tts' | 'stt'

/**
 * Fetch a connection's model list and normalise the per-kind endpoint into the
 * shape `ModelCombobox` wants (`{ models, labels }`). Single source for every
 * connection model picker — `ConnectionSelect`'s paired combobox and the panels
 * that keep their own model row (CouncilManager, MemoryCortexSettings,
 * ExpressionEditorTab) — so the LLM `string[]`/`model_labels` vs imageGen/tts/stt
 * `{ id, label }[]` divergence is handled in one place.
 */
export async function fetchConnectionModels(
  kind: ConnectionKind,
  id: string,
): Promise<{ models: string[]; labels: Record<string, string> }> {
  if (kind === 'llm') {
    const r = await connectionsApi.models(id)
    return { models: r.models || [], labels: r.model_labels || {} }
  }
  // imageGen / tts / stt all return Array<{ id, label }>.
  const api =
    kind === 'imageGen' ? imageGenConnectionsApi : kind === 'tts' ? ttsConnectionsApi : sttConnectionsApi
  const r = await api.models(id)
  const models = (r.models || []).map((m) => m.id)
  const labels: Record<string, string> = {}
  for (const m of r.models || []) labels[m.id] = m.label
  return { models, labels }
}