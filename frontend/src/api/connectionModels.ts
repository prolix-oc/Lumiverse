import { decisionConnectionsApi } from '@/api/decision-connections'
import { connectionsApi } from '@/api/connections'
import { imageGenConnectionsApi } from '@/api/image-gen-connections'
import { ttsConnectionsApi } from '@/api/tts-connections'
import { sttConnectionsApi } from '@/api/stt-connections'

export type ConnectionKind = 'llm' | 'imageGen' | 'tts' | 'stt' | 'decision'

/** Fetch a connection's model list, normalising the per-kind endpoints to `{ models, labels }`. */
export async function fetchConnectionModels(
  kind: ConnectionKind,
  id: string,
): Promise<{ models: string[]; labels: Record<string, string> }> {
  if (kind === 'decision') {
    const r = await decisionConnectionsApi.models(id)
    return { models: r.models.map((m) => m.id), labels: Object.fromEntries(r.models.map((m) => [m.id, m.label])) }
  }
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
