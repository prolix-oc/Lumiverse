import { get, post, put, del } from './client'

export type DecisionData = string | Record<string, unknown> | unknown[]
export type DecisionQuestion =
  | { type: 'choice'; instructions: DecisionData; criteria: Record<string, DecisionData | null> }
  | { type: 'score'; instructions: DecisionData; criteria: DecisionData[] }
  | { type: 'noul'; instructions: DecisionData; criteria?: { true?: DecisionData; false?: DecisionData } }
export interface DecisionRequest {
  connectionId?: string
  state: DecisionData
  questions: Record<string, DecisionQuestion>
}
export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number }
export interface DecisionResult {
  model: string
  answers: Record<string, DecisionAnswer>
  usage?: { input_tokens: number; output_tokens: number }
}
export interface DecisionConnection {
  id: string
  name: string
  provider: string
  gateway: string
  protocol: string
  api_url: string
  model: string
  account_id: string
  is_default: boolean
  has_api_key: boolean
  created_at: number
  updated_at: number
}
export interface DecisionConnectionInput {
  name: string
  provider?: string
  gateway: string
  protocol?: string
  api_url?: string
  model?: string
  account_id?: string
  is_default?: boolean
  api_key?: string
}
export interface DecisionPreset { id: string; name: string; url: string; model: string; protocol: string }
export interface DecisionProviderInfo { id: string; name: string; protocols: string[]; presets: DecisionPreset[] }
export interface DecisionModelPreviewInput {
  connection_id?: string
  provider?: string
  gateway?: string
  protocol?: string
  api_url?: string
  account_id?: string
  api_key?: string
}
export interface DecisionModelList { models: string[]; model_labels: Record<string, string> }

export const decisionsApi = {
  evaluate: (input: DecisionRequest) => post<DecisionResult>('/decisions/evaluate', input),
  presets: () => get<{ providers: DecisionProviderInfo[] }>('/decision-connections/presets'),
  previewModels: (input: DecisionModelPreviewInput) => post<DecisionModelList>('/decision-connections/models/preview', input),
  list: () => get<{ data: DecisionConnection[] }>('/decision-connections'),
  create: (input: DecisionConnectionInput) => post<DecisionConnection>('/decision-connections', input),
  update: (id: string, input: Partial<DecisionConnectionInput>) => put<DecisionConnection>(`/decision-connections/${id}`, input),
  duplicate: (id: string) => post<DecisionConnection>(`/decision-connections/${id}/duplicate`),
  setDefault: (id: string) => post<DecisionConnection>(`/decision-connections/${id}/default`),
  test: (id: string) => post<{ success: boolean; message: string }>(`/decision-connections/${id}/test`),
  delete: (id: string) => del<void>(`/decision-connections/${id}`),
}
