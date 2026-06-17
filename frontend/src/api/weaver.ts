import { get, post, put, patch, del, upload } from './client'
import type { Character, Chat, WorldBook } from '@/types/api'

const LLM_CALL = { timeout: 0 } as const

export type WeaverStage =
  | 'dream'
  | 'readback'
  | 'interview'
  | 'bible'
  | 'render'
  | 'persona'
  | 'finalize'

export type WeaverSessionStatus =
  | 'draft'
  | 'interviewing'
  | 'bible'
  | 'rendering'
  | 'finalized'

export interface WeaverSeed {
  type: string
  text: string
  provenance: Record<string, unknown>
}

export interface WeaverBuildType {
  id: string
  enabled: boolean
  order: number
  hub?: boolean
  door?: boolean
  narration?: boolean
  pairing?: boolean
}

export interface WeaverNarrationMode {
  id: string
  label: string
}

export interface WeaverPersonaRegister {
  id: string
  label: string
}

export interface PersonaDraftSection {
  id: string
  label: string
  lines: string[]
}

export interface PersonaDepthEntry {
  title: string
  content: string
  keys: string[]
}

export interface PersonaDraft {
  name: string
  pronouns: { subjective: string; objective: string; possessive: string }
  sections: PersonaDraftSection[]
  depth: PersonaDepthEntry[]
}

export interface WeaverPersonaPairing {
  greeting: boolean
  register: string
  greeting_text: string
}

export interface WeaverPersonaPlan {
  enabled: boolean
  seed: string
  draft: PersonaDraft | null
  pairing: WeaverPersonaPairing
}

export function emptyPersonaPlan(): WeaverPersonaPlan {
  return {
    enabled: false,
    seed: '',
    draft: null,
    pairing: { greeting: false, register: 'neutral', greeting_text: '' },
  }
}

export interface WeaverSession {
  id: string
  user_id: string
  session_number: number
  created_at: number
  updated_at: number
  build_type: string
  seed: WeaverSeed
  stage: WeaverStage
  status: WeaverSessionStatus
  connection_id: string | null
  model: string | null
  persona_id: string | null
  narration_mode: string | null
  persona_plan: WeaverPersonaPlan
  character_id: string | null
  launch_chat_id: string | null
  interview_started_at: number | null
  interview_completed_at: number | null
  display_name: string | null
}

export interface CreateWeaverSessionInput {
  build_type?: string
  seed_type?: string
  seed_text?: string
  seed_provenance?: Record<string, unknown>
  connection_id?: string
  model?: string
  persona_id?: string
}

export interface UpdateWeaverSessionInput {
  seed_text?: string
  stage?: WeaverStage
  status?: WeaverSessionStatus
  connection_id?: string | null
  model?: string | null
  persona_id?: string | null
  narration_mode?: string | null
  persona_plan?: WeaverPersonaPlan
}

export function createSession(input: CreateWeaverSessionInput = {}): Promise<WeaverSession> {
  return post<WeaverSession>('/weaver/sessions', input)
}

export function listSessions(): Promise<WeaverSession[]> {
  return get<WeaverSession[]>('/weaver/sessions')
}

export function getSession(id: string): Promise<WeaverSession> {
  return get<WeaverSession>(`/weaver/sessions/${id}`)
}

export function updateSession(
  id: string,
  input: UpdateWeaverSessionInput,
): Promise<WeaverSession> {
  return patch<WeaverSession>(`/weaver/sessions/${id}`, input)
}

export function deleteSession(id: string): Promise<{ success: boolean }> {
  return del<{ success: boolean }>(`/weaver/sessions/${id}`)
}

export interface WeaverVisualKindMeta {
  id: string
  width: number
  height: number
  aspect_ratio: string
  base_negative: string
  variants?: WeaverVisualVariantDef[]
}

export interface WeaverVisualVariantDef {
  id: string
  tags: string
  negative_tags?: string
  cues: string
}

export interface WeaverVisualImageInputSupport {
  supported: boolean
  mechanism: 'edit' | 'reference' | 'init' | null
  reason?: string
}

export interface WeaverVisualJobProgress {
  stage: string
  message: string
  step?: number
  totalSteps?: number
  preview?: string
  nodeId?: string
}

export interface WeaverVisualJobResult {
  image_id?: string
  image_url?: string
  settingsSnapshot: Record<string, unknown>
}

export type WeaverVisualJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export interface WeaverVisualJob {
  id: string
  userId: string
  sessionId: string
  characterId: string
  kind: string
  variant: string | null
  connectionId: string
  status: WeaverVisualJobStatus
  progress: WeaverVisualJobProgress
  result: WeaverVisualJobResult | null
  error: string | null
  createdAt: number
  updatedAt: number
  startedAt: number | null
  completedAt: number | null
}

export interface WeaverVisualGenerateInput {
  kind: string
  prompt: string
  connection_id: string
  negative_prompt?: string
  width?: number
  height?: number
  aspect_ratio?: string
  seed?: number | null
  variant?: string
  provider_state?: Record<string, unknown>
  source_image_id?: string
}

export interface WeaverVisualCandidate {
  id: string
  url: string
  width: number | null
  height: number | null
  created_at?: number
}

export function getVisualKinds(): Promise<WeaverVisualKindMeta[]> {
  return get<WeaverVisualKindMeta[]>('/weaver/visual/kinds')
}

export function generateVisual(sessionId: string, input: WeaverVisualGenerateInput): Promise<WeaverVisualJob> {
  return post<WeaverVisualJob>(`/weaver/sessions/${sessionId}/visual/generate`, input)
}

export function getVisualJob(sessionId: string, jobId: string): Promise<WeaverVisualJob> {
  return get<WeaverVisualJob>(`/weaver/sessions/${sessionId}/visual/job/${jobId}`)
}

export function listVisualCandidates(
  sessionId: string,
  kind: string,
  variant?: string,
): Promise<{ data: WeaverVisualCandidate[]; total: number }> {
  return get<{ data: WeaverVisualCandidate[]; total: number }>(
    `/weaver/sessions/${sessionId}/visual/candidates`,
    variant ? { kind, variant } : { kind },
  )
}

export function getVisualImageInput(
  sessionId: string,
  connectionId: string,
): Promise<WeaverVisualImageInputSupport> {
  return get<WeaverVisualImageInputSupport>(
    `/weaver/sessions/${sessionId}/visual/image-input`,
    { connection_id: connectionId },
  )
}

export function commitAvatar(sessionId: string, imageId: string): Promise<Character> {
  return post<Character>(`/weaver/sessions/${sessionId}/visual/commit/avatar`, { image_id: imageId })
}

export interface WeaverExpressionConfig {
  enabled: boolean
  defaultExpression: string
  mappings: Record<string, string>
}

export function commitExpressions(
  sessionId: string,
  mappings: Record<string, string>,
): Promise<WeaverExpressionConfig> {
  return post<WeaverExpressionConfig>(
    `/weaver/sessions/${sessionId}/visual/commit/expressions`,
    { mappings },
  )
}

export function suggestVisualTags(sessionId: string): Promise<{ suggestedTags: string; suggestedNegativeTags: string }> {
  return post<{ suggestedTags: string; suggestedNegativeTags: string }>(
    `/weaver/sessions/${sessionId}/visual/suggest-tags`,
    {},
    LLM_CALL,
  )
}

export type WeaverSlotImpact = 'critical' | 'high' | 'medium' | 'low'
export type WeaverSlotFill = 'elicit' | 'generate'

export interface WeaverSpinePart {
  id: string
  label: string
  fill: WeaverSlotFill
  description?: string
}

export interface WeaverSpineSlot {
  id: string
  category: string
  label: string
  description: string
  impact: WeaverSlotImpact
  fill: WeaverSlotFill
  synthesisGroup?: string
  parts?: WeaverSpinePart[]
  optional?: boolean
}

export interface WeaverCommittedFact {
  slot: string
  part?: string
  fact: string
  source: 'extracted' | 'user'
}

export interface WeaverGap {
  slot: string
  note: string
  source: 'extracted' | 'user'
}

export interface WeaverExtraction {
  session_id: string
  committed_facts: WeaverCommittedFact[]
  gaps: WeaverGap[]
  edited_at: number
}

export function listBuildTypes(): Promise<WeaverBuildType[]> {
  return get<WeaverBuildType[]>('/weaver/build-types')
}

export function listNarrationModes(): Promise<WeaverNarrationMode[]> {
  return get<WeaverNarrationMode[]>('/weaver/narration-modes')
}

export function listPersonaRegisters(): Promise<WeaverPersonaRegister[]> {
  return get<WeaverPersonaRegister[]>('/weaver/persona-registers')
}

export function generatePersonaDraft(sessionId: string): Promise<PersonaDraft> {
  return post<PersonaDraft>(`/weaver/sessions/${sessionId}/persona/generate`, {}, LLM_CALL)
}

export function generatePersonaGreeting(
  sessionId: string,
  draft: PersonaDraft,
  register: string,
): Promise<{ greeting: string }> {
  return post<{ greeting: string }>(
    `/weaver/sessions/${sessionId}/persona/greeting`,
    { draft, register },
    LLM_CALL,
  )
}

// ----- The import door (FULL_WEAVER_PLAN §6) -----

export interface WeaverImportReading {
  action: string
  reason: string
}

export interface WeaverImportFieldStat {
  id: string
  words: number
}

export interface WeaverImportInspection {
  artifact: 'card' | 'worldbook'
  format: string
  name: string
  field_stats: WeaverImportFieldStat[]
  entry_count: number
  has_embedded_book: boolean
  has_portrait: boolean
  source_chars: number
  actions: string[]
  reading: WeaverImportReading | null
}

export interface WeaverImportStartResult {
  session?: WeaverSession
  world_book?: WorldBook
  book_work?: boolean
}

export interface WeaverEnrichEntryResult {
  entry_id: string
  enriched: boolean
  content: string
  note: string
}

export function inspectImport(file: File): Promise<WeaverImportInspection> {
  const form = new FormData()
  form.append('file', file)
  return upload<WeaverImportInspection>('/weaver/import/inspect', form, LLM_CALL)
}

export function startImport(file: File, action: string): Promise<WeaverImportStartResult> {
  const form = new FormData()
  form.append('file', file)
  form.append('action', action)
  return upload<WeaverImportStartResult>('/weaver/import/start', form, LLM_CALL)
}

export function enrichImportEntry(bookId: string, entryId: string): Promise<WeaverEnrichEntryResult> {
  return post<WeaverEnrichEntryResult>(`/weaver/import/enrich/${bookId}/entries/${entryId}`, {}, LLM_CALL)
}

export interface WeaverSynthesisGroup {
  id: string
  label: string
  instruction: string
}

export interface WeaverBookRole {
  id: string
  label: string
  defaultEnabled: boolean
  triggering: string
}

export interface WeaverSlotsResponse {
  slots: WeaverSpineSlot[]
  groups: WeaverSynthesisGroup[]
  bookRoles: WeaverBookRole[]
}

export function getSlots(buildType: string): Promise<WeaverSlotsResponse> {
  return get<WeaverSlotsResponse>(`/weaver/slots?build_type=${encodeURIComponent(buildType)}`)
}

export function getExtraction(sessionId: string): Promise<WeaverExtraction> {
  return get<WeaverExtraction>(`/weaver/sessions/${sessionId}/extraction`)
}

export function runReadback(sessionId: string): Promise<WeaverExtraction> {
  return post<WeaverExtraction>(`/weaver/sessions/${sessionId}/readback`, {}, LLM_CALL)
}

export function updateExtraction(
  sessionId: string,
  input: { committed_facts?: WeaverCommittedFact[]; gaps?: WeaverGap[] },
): Promise<WeaverExtraction> {
  return patch<WeaverExtraction>(`/weaver/sessions/${sessionId}/extraction`, input)
}

export type WeaverResponseKind =
  | 'typed'
  | 'picked'
  | 'enhanced'
  | 'pick'
  | 'blend'
  | 'redirect'
  | 'inferred'

export interface WeaverCandidate {
  caption: string
  content: string
}

export interface WeaverElicitTarget {
  slot: string
  part: string
  label: string
}

export const DYNAMIC_TARGET = 'dynamic'

export interface WeaverInterviewQuestion {
  id: string
  prompt: string
  why: string
  target: string
}

export interface WeaverInterviewTurn {
  id: string
  session_id: string
  seq: number
  slot: string
  part: string
  question: { prompt: string; why: string }
  response_kind: WeaverResponseKind
  response: string
  created_at: number
}

export type WeaverInterviewPhase = 'pending' | 'active' | 'complete'

export const OPT_IN_PREFIX = 'optin'

export interface WeaverInterviewState {
  phase: WeaverInterviewPhase
  answered: WeaverInterviewTurn[]
  remaining_targets: WeaverElicitTarget[]
  no_gaps_remaining: boolean
  dynamic_count: number
  at_dynamic_cap: boolean
  opt_in: { slot: string } | null
}

export function getInterviewState(sessionId: string): Promise<WeaverInterviewState> {
  return get<WeaverInterviewState>(`/weaver/sessions/${sessionId}/interview`)
}

export function generateQuestion(
  sessionId: string,
  input: { steer?: string; avoid?: string[] } = {},
): Promise<{ question: WeaverInterviewQuestion | null }> {
  return post<{ question: WeaverInterviewQuestion | null }>(
    `/weaver/sessions/${sessionId}/interview/question`,
    input,
    LLM_CALL,
  )
}

export function answerQuestion(
  sessionId: string,
  input: {
    question: WeaverInterviewQuestion
    kind: WeaverResponseKind
    content: string
    steer?: string
  },
): Promise<WeaverInterviewState> {
  // The answer runs a spillover listen pass server-side, so it is an LLM-length call.
  return post<WeaverInterviewState>(`/weaver/sessions/${sessionId}/interview/answer`, input, LLM_CALL)
}

export function sparkQuestion(
  sessionId: string,
  input: { question: WeaverInterviewQuestion; steer?: string; avoid?: string[] },
): Promise<{ options: WeaverCandidate[] }> {
  return post<{ options: WeaverCandidate[] }>(
    `/weaver/sessions/${sessionId}/interview/spark`,
    input,
    LLM_CALL,
  )
}

export function enhanceAnswer(
  sessionId: string,
  input: { question: WeaverInterviewQuestion; draft: string },
): Promise<{ options: WeaverCandidate[] }> {
  return post<{ options: WeaverCandidate[] }>(
    `/weaver/sessions/${sessionId}/interview/enhance`,
    input,
    LLM_CALL,
  )
}

export function decideOptIn(
  sessionId: string,
  input: { slot: string; enabled: boolean },
): Promise<WeaverInterviewState> {
  return post<WeaverInterviewState>(`/weaver/sessions/${sessionId}/interview/optin`, input)
}

export function resetInterview(sessionId: string): Promise<WeaverInterviewState> {
  return post<WeaverInterviewState>(`/weaver/sessions/${sessionId}/interview/reset`, {})
}

export function beginInterview(sessionId: string): Promise<WeaverInterviewState> {
  return post<WeaverInterviewState>(`/weaver/sessions/${sessionId}/interview/begin`, {})
}

export function completeInterview(sessionId: string): Promise<WeaverInterviewState> {
  return post<WeaverInterviewState>(`/weaver/sessions/${sessionId}/interview/complete`, {})
}

export type WeaverBibleOrigin = 'established' | 'authored' | 'inferred'
export type WeaverBibleStatus = 'pending' | 'gated' | 'flagged'

export interface WeaverBibleEntryPart {
  id: string
  content: string
  origin: WeaverBibleOrigin
}

export interface WeaverBibleEntry {
  slot: string
  content: string
  origin: WeaverBibleOrigin
  parts?: WeaverBibleEntryPart[]
}

export interface WeaverBibleCausalLink {
  from: string
  to: string
  relation: string
}

export interface WeaverBibleDynamicEntry {
  id: string
  question: string
  content: string
  origin: WeaverBibleOrigin
}

export interface WeaverBibleSpine {
  entries: WeaverBibleEntry[]
  causal_links: WeaverBibleCausalLink[]
  brief: string
  dynamic: WeaverBibleDynamicEntry[]
}

export interface WeaverGateCriterion {
  key: string
  label: string
  passed: boolean
  note: string
}

export interface WeaverGateVerdict {
  passed: boolean
  criteria: WeaverGateCriterion[]
  summary: string
}

export interface WeaverTokenUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  calls: number
}

export interface WeaverBible {
  session_id: string
  spine: WeaverBibleSpine
  status: WeaverBibleStatus
  gate: WeaverGateVerdict | null
  token_usage: WeaverTokenUsage
  gated_at: number | null
  updated_at: number | null
}

export interface UpdateWeaverBibleInput {
  entries?: WeaverBibleEntry[]
  causal_links?: WeaverBibleCausalLink[]
  brief?: string
}

export function getBible(sessionId: string): Promise<WeaverBible> {
  return get<WeaverBible>(`/weaver/sessions/${sessionId}/bible`)
}

export function synthesizeBible(sessionId: string): Promise<WeaverBible> {
  return post<WeaverBible>(`/weaver/sessions/${sessionId}/bible/synthesize`, {}, LLM_CALL)
}

export function gateBible(sessionId: string): Promise<WeaverBible> {
  return post<WeaverBible>(`/weaver/sessions/${sessionId}/bible/gate`, {}, LLM_CALL)
}

export function updateBible(
  sessionId: string,
  input: UpdateWeaverBibleInput,
): Promise<WeaverBible> {
  return patch<WeaverBible>(`/weaver/sessions/${sessionId}/bible`, input)
}

export function resynthesizeBibleEntry(
  sessionId: string,
  slot: string,
  nudge?: string,
): Promise<WeaverBible> {
  return post<WeaverBible>(
    `/weaver/sessions/${sessionId}/bible/entries/${slot}/resynthesize`,
    nudge && nudge.trim() ? { nudge: nudge.trim() } : {},
    LLM_CALL,
  )
}

export type WeaverFieldKind = 'short' | 'bundle' | 'voice' | 'scene' | 'voiced' | 'alichat' | 'greetings'
export type WeaverFieldRender = 'synthesize' | 'direct'

export interface WeaverFieldDef {
  id: string
  label: string
  charlField: string
  order: number
  kind: WeaverFieldKind
  render: WeaverFieldRender
  directSlot?: string
  primarySlots: string[]
  renderGuidance: string
  usesVoiceMaterial?: boolean
  list?: { separator: string }
}

export type WeaverFieldStatus =
  | 'pending'
  | 'streaming'
  | 'passed'
  | 'flagged'
  | 'stale'
  | 'manually_edited'

export interface WeaverFieldProvenance {
  bible_gated_at: number | null
  bible_updated_at: number | null
  bible_status: WeaverBibleStatus
  gate: WeaverGateVerdict | null
  revised: boolean
  bible_spine_hash?: string | null
  accepted?: boolean
  nudge?: string
}

export interface WeaverField {
  id: string
  session_id: string
  field_name: string
  content: string
  status: WeaverFieldStatus
  provenance: WeaverFieldProvenance
  token_usage: WeaverTokenUsage
  updated_at: number
  stale?: boolean
}

export function getFieldDefs(buildType: string): Promise<WeaverFieldDef[]> {
  return get<WeaverFieldDef[]>(`/weaver/field-defs?build_type=${encodeURIComponent(buildType)}`)
}

export function getFields(sessionId: string): Promise<WeaverField[]> {
  return get<WeaverField[]>(`/weaver/sessions/${sessionId}/fields`)
}

export function renderFields(sessionId: string): Promise<WeaverField[]> {
  return post<WeaverField[]>(`/weaver/sessions/${sessionId}/fields/render`, {}, LLM_CALL)
}

export function renderField(sessionId: string, fieldId: string, force = false): Promise<WeaverField> {
  return post<WeaverField>(`/weaver/sessions/${sessionId}/fields/${fieldId}/render`, force ? { force: true } : {}, LLM_CALL)
}

export function editField(sessionId: string, fieldId: string, content: string): Promise<WeaverField> {
  return patch<WeaverField>(`/weaver/sessions/${sessionId}/fields/${fieldId}`, { content })
}

export function acceptField(sessionId: string, fieldId: string, accepted: boolean): Promise<WeaverField> {
  return post<WeaverField>(`/weaver/sessions/${sessionId}/fields/${fieldId}/accept`, { accepted })
}

export function nudgeField(sessionId: string, fieldId: string, nudge: string, force = false): Promise<WeaverField> {
  return post<WeaverField>(
    `/weaver/sessions/${sessionId}/fields/${fieldId}/nudge`,
    force ? { nudge, force: true } : { nudge },
    LLM_CALL,
  )
}

export interface WeaverFinalizeResult {
  books: Record<string, WorldBook | null>
  book_errors?: Record<string, string>
  character: Character
  depth_book: WorldBook | null
  depth_book_error?: string
  persona_id: string | null
}

export interface WeaverFinalizeInput {
  books?: Record<string, boolean>
  depth_book?: boolean
}

export interface WeaverStartChatResult {
  chat: Chat
}

export interface WeaverHubBook {
  id: string
  name: string
  role: string | null
  entry_count: number
}

export interface WeaverHubCharacter {
  id: string
  name: string
}

export interface WeaverHubPromotion {
  person_id: string
  name: string
  session_id: string
}

export interface WeaverAgencyState {
  present: boolean
  enabled: boolean
  agenda: string
  holds: string[]
}

export interface WeaverHubSummary {
  character_id: string
  character_name: string
  build_type: string
  book_roles: string[]
  people: { question_target: number } | null
  agency: WeaverAgencyState | null
  books: WeaverHubBook[]
  characters: WeaverHubCharacter[]
  promotions: WeaverHubPromotion[]
}

export function getHub(sessionId: string): Promise<WeaverHubSummary> {
  return get<WeaverHubSummary>(`/weaver/sessions/${sessionId}/hub`)
}

export function setAgencyEnabled(
  sessionId: string,
  enabled: boolean,
): Promise<{ agency: WeaverAgencyState }> {
  return post<{ agency: WeaverAgencyState }>(`/weaver/sessions/${sessionId}/agency`, { enabled })
}

export function updateAgency(
  sessionId: string,
  input: { agenda: string; holds: string[] },
): Promise<{ agency: WeaverAgencyState }> {
  return put<{ agency: WeaverAgencyState }>(`/weaver/sessions/${sessionId}/agency`, input)
}

export function loreQuestion(
  sessionId: string,
  input: { steer?: string; avoid?: string[] } = {},
): Promise<{ question: WeaverInterviewQuestion | null }> {
  return post<{ question: WeaverInterviewQuestion | null }>(
    `/weaver/sessions/${sessionId}/lore/question`,
    input,
    LLM_CALL,
  )
}

export interface WeaverLoreAnswerResult {
  added: number
  book: WeaverHubBook | null
  book_error?: string
}

export function loreAnswer(
  sessionId: string,
  input: { question: WeaverInterviewQuestion; kind: WeaverResponseKind; content: string },
): Promise<WeaverLoreAnswerResult> {
  return post<WeaverLoreAnswerResult>(`/weaver/sessions/${sessionId}/lore/answer`, input, LLM_CALL)
}

export function finalizeSession(sessionId: string, input: WeaverFinalizeInput = {}): Promise<WeaverFinalizeResult> {
  return post<WeaverFinalizeResult>(`/weaver/sessions/${sessionId}/finalize`, input, LLM_CALL)
}

export type WeaverPersonTier = 'unfleshed' | 'extra' | 'named'

export interface WeaverPersonAnswer {
  id: string
  question: string
  answer: string
  kind: WeaverResponseKind
}

export interface WeaverPerson {
  id: string
  session_id: string
  name: string
  hook: string
  origin: 'proposed' | 'manual' | 'interview'
  tier: WeaverPersonTier
  interview: WeaverPersonAnswer[]
  npc_entry_id: string | null
  promoted_session_id: string | null
  created_at: number
  updated_at: number
}

export function getPeople(sessionId: string): Promise<{ people: WeaverPerson[] }> {
  return get<{ people: WeaverPerson[] }>(`/weaver/sessions/${sessionId}/people`)
}

export interface WeaverTuning {
  propose_count: number | null
  named_question_target: number | null
  dynamic_question_cap: number | null
  harvest_cap: number | null
  generation_temperature: number | null
  review_temperature: number | null
}

export interface WeaverTuningResponse {
  tuning: WeaverTuning
  defaults: Record<string, number>
}

export function getTuning(): Promise<WeaverTuningResponse> {
  return get<WeaverTuningResponse>('/weaver/tuning')
}

export function putTuning(input: Partial<WeaverTuning>): Promise<WeaverTuningResponse> {
  return put<WeaverTuningResponse>('/weaver/tuning', input)
}

export function proposePeople(
  sessionId: string,
): Promise<{ proposed: WeaverPerson[]; people: WeaverPerson[] }> {
  return post<{ proposed: WeaverPerson[]; people: WeaverPerson[] }>(
    `/weaver/sessions/${sessionId}/people/propose`,
    {},
    LLM_CALL,
  )
}

export function addPerson(
  sessionId: string,
  input: { name: string; hook?: string },
): Promise<{ person: WeaverPerson }> {
  return post<{ person: WeaverPerson }>(`/weaver/sessions/${sessionId}/people`, input)
}

export function removePerson(sessionId: string, personId: string): Promise<{ removed: boolean }> {
  return del<{ removed: boolean }>(`/weaver/sessions/${sessionId}/people/${personId}`)
}

export interface WeaverPersonFleshResult {
  person: WeaverPerson
  book: { id: string; name: string }
}

export function fleshExtra(sessionId: string, personId: string): Promise<WeaverPersonFleshResult> {
  return post<WeaverPersonFleshResult>(`/weaver/sessions/${sessionId}/people/${personId}/extra`, {}, LLM_CALL)
}

export function personQuestion(
  sessionId: string,
  personId: string,
  input: { avoid?: string[] } = {},
): Promise<{ question: WeaverInterviewQuestion | null }> {
  return post<{ question: WeaverInterviewQuestion | null }>(
    `/weaver/sessions/${sessionId}/people/${personId}/question`,
    input,
    LLM_CALL,
  )
}

export function answerPersonQuestion(
  sessionId: string,
  personId: string,
  input: { question: WeaverInterviewQuestion; kind: WeaverResponseKind; content: string },
): Promise<{ person: WeaverPerson }> {
  return post<{ person: WeaverPerson }>(`/weaver/sessions/${sessionId}/people/${personId}/answer`, input)
}

export function weaveNamed(sessionId: string, personId: string): Promise<WeaverPersonFleshResult> {
  return post<WeaverPersonFleshResult>(`/weaver/sessions/${sessionId}/people/${personId}/weave`, {}, LLM_CALL)
}

export function promoteNamed(sessionId: string, personId: string): Promise<{ session: WeaverSession }> {
  return post<{ session: WeaverSession }>(`/weaver/sessions/${sessionId}/people/${personId}/promote`, {})
}

export function startChat(sessionId: string): Promise<WeaverStartChatResult> {
  return post<WeaverStartChatResult>(`/weaver/sessions/${sessionId}/start-chat`, {})
}
