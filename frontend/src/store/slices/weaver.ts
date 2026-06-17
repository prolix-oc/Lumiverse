import type { StateCreator } from 'zustand'
import type { AppStore, WeaverSlice } from '@/types/store'
import type { WeaverSession, WeaverField } from '@/api/weaver'
import * as api from '@/api/weaver'
import { isEmptyDraft } from '@/components/weaver/sessionDisplay'

function replaceSession(sessions: WeaverSession[], updated: WeaverSession): WeaverSession[] {
  return sessions.map((s) => (s.id === updated.id ? updated : s))
}

function upsertRenderedField(
  state: AppStore,
  sessionId: string,
  fieldId: string,
  field: WeaverField,
): Partial<AppStore> {
  const exists = state.weaverFields.some((f) => f.field_name === fieldId)
  return {
    weaverFields: exists
      ? state.weaverFields.map((f) => (f.field_name === fieldId ? field : f))
      : [...state.weaverFields, field],
    weaverStateSessionId: sessionId,
    weaverSessions: state.weaverSessions.map((s) =>
      s.id === sessionId ? { ...s, stage: 'render' } : s,
    ),
  }
}

const HIDE_ADVISORIES_KEY = 'weaver:hideAdvisories'

function readHideAdvisories(): boolean {
  try {
    return localStorage.getItem(HIDE_ADVISORIES_KEY) === '1'
  } catch {
    return false
  }
}

function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'body' in err) {
    const body = (err as { body?: { error?: string } }).body
    if (body?.error) return body.error
  }
  return err instanceof Error ? err.message : 'Something went wrong'
}

export const createWeaverSlice: StateCreator<AppStore, [], [], WeaverSlice> = (set, get) => ({
  weaverSessions: [],
  activeWeaverSessionId: null,
  weaverLoading: false,
  weaverChooserIntent: false,
  setWeaverChooserIntent: (intent) => set({ weaverChooserIntent: intent }),

  weaverHideAdvisories: readHideAdvisories(),
  setWeaverHideAdvisories: (hide) => {
    try {
      if (hide) localStorage.setItem(HIDE_ADVISORIES_KEY, '1')
      else localStorage.removeItem(HIDE_ADVISORIES_KEY)
    } catch {
      /* preference persistence is best-effort */
    }
    set({ weaverHideAdvisories: hide })
  },

  loadWeaverSessions: async () => {
    set({ weaverLoading: true })
    try {
      const sessions = await api.listSessions()
      set({ weaverSessions: sessions })
    } finally {
      set({ weaverLoading: false })
    }
  },

  createWeaverSession: async (input) => {
    const state = get()
    const profiles = state.profiles ?? []
    const resolvedId =
      (state.activeProfileId && profiles.some((p) => p.id === state.activeProfileId)
        ? state.activeProfileId
        : profiles.find((p) => p.is_default)?.id ?? profiles[0]?.id) ?? undefined
    const session = await api.createSession({
      ...(resolvedId ? { connection_id: resolvedId } : {}),
      ...input,
    })
    set((s) => ({
      weaverSessions: [session, ...s.weaverSessions],
      activeWeaverSessionId: session.id,
      weaverStateSessionId: session.id,
      weaverExtraction: null,
      weaverInterview: null,
      weaverQuestion: null,
      weaverInterviewError: null,
      weaverReadbackError: null,
      weaverBible: null,
      weaverBibleError: null,
      weaverFields: [],
      weaverFieldRendering: [],
      weaverRenderError: null,
      weaverFinalizeError: null,
      weaverFinalizeResult: null,
    }))
    return session
  },

  openWeaverSession: (id) => {
    const prevId = get().activeWeaverSessionId
    if (prevId && prevId !== id) {
      const departing = get().weaverSessions.find((s) => s.id === prevId)
      if (departing && isEmptyDraft(departing)) {
        void get().deleteWeaverSession(prevId).catch(() => { /* a failed reap is harmless */ })
      }
    }
    set((s) => ({
      activeWeaverSessionId: id,
      ...(id === s.activeWeaverSessionId
        ? {}
        : {
            weaverExtraction: null,
            weaverInterview: null,
            weaverQuestion: null,
            weaverInterviewError: null,
            weaverReadbackError: null,
            weaverBible: null,
            weaverBibleError: null,
            weaverFields: [],
            weaverFieldRendering: [],
            weaverRenderError: null,
            weaverFinalizeError: null,
            weaverFinalizeResult: null,
            weaverStateSessionId: id,
          }),
    }))
  },

  updateWeaverSeed: async (id, text) => {
    if (get().activeWeaverSessionId !== id) return
    const updated = await api.updateSession(id, { seed_text: text })
    set((state) => ({ weaverSessions: replaceSession(state.weaverSessions, updated) }))
  },

  setWeaverSessionConfig: async (id, patch) => {
    if (get().activeWeaverSessionId !== id) return
    const updated = await api.updateSession(id, patch)
    set((state) => ({ weaverSessions: replaceSession(state.weaverSessions, updated) }))
  },

  setWeaverStage: async (id, stage) => {
    if (get().activeWeaverSessionId !== id) return
    const updated = await api.updateSession(id, { stage })
    set((state) => ({ weaverSessions: replaceSession(state.weaverSessions, updated) }))
  },

  deleteWeaverSession: async (id) => {
    set((state) => ({
      weaverSessions: state.weaverSessions.filter((s) => s.id !== id),
      activeWeaverSessionId: state.activeWeaverSessionId === id ? null : state.activeWeaverSessionId,
    }))
    await api.deleteSession(id)
  },

  weaverSlots: [],
  weaverSlotGroups: [],
  weaverBookRoles: [],
  weaverSlotsBuildType: null,
  weaverBuildTypes: [],
  weaverNarrationModes: [],
  weaverPersonaRegisters: [],
  weaverExtraction: null,
  weaverReadbackRunning: false,
  weaverReadbackError: null,

  weaverPersonaDraft: null,
  weaverPersonaGenerating: false,
  weaverPersonaGreetingGenerating: false,
  weaverPersonaError: null,

  loadWeaverSlots: async (buildType) => {
    if (get().weaverSlotsBuildType === buildType && get().weaverSlots.length > 0) return
    const res = await api.getSlots(buildType)
    set({
      weaverSlots: res.slots,
      weaverSlotGroups: res.groups,
      weaverBookRoles: res.bookRoles,
      weaverSlotsBuildType: buildType,
    })
  },

  loadWeaverBuildTypes: async () => {
    if (get().weaverBuildTypes.length > 0) return
    const types = await api.listBuildTypes()
    set({ weaverBuildTypes: [...types].sort((a, b) => a.order - b.order) })
  },

  loadWeaverNarrationModes: async () => {
    if (get().weaverNarrationModes.length > 0) return
    const modes = await api.listNarrationModes()
    set({ weaverNarrationModes: modes })
  },

  loadWeaverPersonaRegisters: async () => {
    if (get().weaverPersonaRegisters.length > 0) return
    const registers = await api.listPersonaRegisters()
    set({ weaverPersonaRegisters: registers })
  },

  loadWeaverExtraction: async (sessionId) => {
    try {
      const extraction = await api.getExtraction(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverExtraction: extraction, weaverStateSessionId: sessionId })
    } catch {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverExtraction: null })
    }
  },

  runWeaverReadback: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverReadbackRunning: true, weaverReadbackError: null })
    try {
      const extraction = await api.runReadback(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => ({
        weaverExtraction: extraction,
        weaverStateSessionId: sessionId,
        weaverSessions: state.weaverSessions.map((s) =>
          s.id === sessionId ? { ...s, stage: 'readback' } : s,
        ),
      }))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverReadbackError: errorMessage(err) })
    } finally {
      set({ weaverReadbackRunning: false })
    }
  },

  saveWeaverExtraction: async (sessionId, input) => {
    if (get().activeWeaverSessionId !== sessionId) return
    const extraction = await api.updateExtraction(sessionId, input)
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverExtraction: extraction })
  },

  weaverInterview: null,
  weaverQuestion: null,
  weaverQuestionLoading: false,
  weaverInterviewError: null,
  weaverStateSessionId: null,

  loadWeaverInterview: async (sessionId) => {
    const state = await api.getInterviewState(sessionId)
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverInterview: state, weaverStateSessionId: sessionId })
  },

  beginWeaverInterview: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverQuestionLoading: true, weaverInterviewError: null })
    try {
      const state = await api.beginInterview(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterview: state, weaverStateSessionId: sessionId })
      if (!state.opt_in && (!state.no_gaps_remaining || !state.at_dynamic_cap)) {
        await (get() as AppStore).nextWeaverQuestion(sessionId)
      }
      set((s) => ({
        weaverSessions: s.weaverSessions.map((sess) =>
          sess.id === sessionId ? { ...sess, stage: 'interview' } : sess,
        ),
      }))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterviewError: errorMessage(err) })
    } finally {
      set({ weaverQuestionLoading: false })
    }
  },

  nextWeaverQuestion: async (sessionId, steer) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverQuestionLoading: true, weaverInterviewError: null })
    try {
      const current = get().weaverQuestion
      const avoid = steer && current ? [current.prompt] : undefined
      const { question } = await api.generateQuestion(sessionId, steer ? { steer, avoid } : {})
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverQuestion: question, weaverStateSessionId: sessionId })
      if (!question) {
        const state = await api.getInterviewState(sessionId)
        if (get().activeWeaverSessionId !== sessionId) return
        set({ weaverInterview: state })
      }
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterviewError: errorMessage(err) })
    } finally {
      set({ weaverQuestionLoading: false })
    }
  },

  answerWeaverQuestion: async (sessionId, input) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverInterviewError: null })
    try {
      const state = await api.answerQuestion(sessionId, input)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterview: state, weaverQuestion: null, weaverStateSessionId: sessionId })
      if (!state.opt_in && (!state.no_gaps_remaining || !state.at_dynamic_cap)) {
        await (get() as AppStore).nextWeaverQuestion(sessionId)
      }
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterviewError: errorMessage(err) })
    }
  },

  sparkWeaverQuestion: async (sessionId, steer, avoid) => {
    const question = get().weaverQuestion
    if (!question) return []
    const { options } = await api.sparkQuestion(sessionId, {
      question,
      ...(steer ? { steer } : {}),
      ...(avoid && avoid.length > 0 ? { avoid } : {}),
    })
    return options
  },

  enhanceWeaverAnswer: async (sessionId, draft) => {
    const question = get().weaverQuestion
    if (!question) return []
    const { options } = await api.enhanceAnswer(sessionId, { question, draft })
    return options
  },

  decideWeaverOptIn: async (sessionId, slot, enabled) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverInterviewError: null })
    try {
      const state = await api.decideOptIn(sessionId, { slot, enabled })
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterview: state, weaverStateSessionId: sessionId })
      if (enabled) {
        const extraction = await api.getExtraction(sessionId).catch(() => null)
        if (get().activeWeaverSessionId !== sessionId) return
        if (extraction) set({ weaverExtraction: extraction })
      }
      if (!state.opt_in && (!state.no_gaps_remaining || !state.at_dynamic_cap)) {
        await (get() as AppStore).nextWeaverQuestion(sessionId)
      }
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterviewError: errorMessage(err) })
    }
  },

  completeWeaverInterview: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    const state = await api.completeInterview(sessionId)
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverInterview: state, weaverQuestion: null, weaverStateSessionId: sessionId })
  },

  resetWeaverInterview: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverQuestionLoading: true, weaverInterviewError: null, weaverQuestion: null })
    try {
      const state = await api.resetInterview(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterview: state, weaverStateSessionId: sessionId })
      const extraction = await api.getExtraction(sessionId).catch(() => null)
      if (get().activeWeaverSessionId !== sessionId) return
      if (extraction) set({ weaverExtraction: extraction })
      if (!state.opt_in && (!state.no_gaps_remaining || !state.at_dynamic_cap)) {
        await (get() as AppStore).nextWeaverQuestion(sessionId)
      }
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverInterviewError: errorMessage(err) })
    } finally {
      set({ weaverQuestionLoading: false })
    }
  },

  weaverBible: null,
  weaverBibleRunning: false,
  weaverBibleError: null,

  loadWeaverBible: async (sessionId) => {
    try {
      const bible = await api.getBible(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverBible: bible, weaverStateSessionId: sessionId })
    } catch {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverBible: null })
    }
  },

  synthesizeWeaverBible: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverBibleRunning: true, weaverBibleError: null })
    try {
      const bible = await api.synthesizeBible(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => ({
        weaverBible: bible,
        weaverStateSessionId: sessionId,
        weaverSessions: state.weaverSessions.map((s) =>
          s.id === sessionId ? { ...s, stage: 'bible' } : s,
        ),
      }))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      try {
        const bible = await api.getBible(sessionId)
        if (get().activeWeaverSessionId !== sessionId) return
        set((state) => ({
          weaverBible: bible,
          weaverStateSessionId: sessionId,
          weaverSessions: state.weaverSessions.map((s) =>
            s.id === sessionId ? { ...s, stage: 'bible' } : s,
          ),
        }))
      } catch {
        if (get().activeWeaverSessionId !== sessionId) return
        set({ weaverBibleError: errorMessage(err) })
      }
    } finally {
      set({ weaverBibleRunning: false })
    }
  },

  gateWeaverBible: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverBibleRunning: true, weaverBibleError: null })
    try {
      const bible = await api.gateBible(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverBible: bible, weaverStateSessionId: sessionId })
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverBibleError: errorMessage(err) })
    } finally {
      set({ weaverBibleRunning: false })
    }
  },

  saveWeaverBible: async (sessionId, input) => {
    if (get().activeWeaverSessionId !== sessionId) return
    const bible = await api.updateBible(sessionId, input)
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverBible: bible })
  },

  resynthesizeWeaverBibleEntry: async (sessionId, slot, nudge) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverBibleRunning: true, weaverBibleError: null })
    try {
      const bible = await api.resynthesizeBibleEntry(sessionId, slot, nudge)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverBible: bible, weaverStateSessionId: sessionId })
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverBibleError: errorMessage(err) })
    } finally {
      if (get().activeWeaverSessionId === sessionId) set({ weaverBibleRunning: false })
    }
  },

  weaverFieldDefs: [],
  weaverFieldDefsBuildType: null,
  weaverFields: [],
  weaverFieldRendering: [],
  weaverRenderError: null,

  weaverFinalizing: false,
  weaverStartingChat: false,
  weaverFinalizeError: null,
  weaverFinalizeResult: null,

  loadWeaverFieldDefs: async (buildType) => {
    if (get().weaverFieldDefsBuildType === buildType && get().weaverFieldDefs.length > 0) return
    const defs = await api.getFieldDefs(buildType)
    set({ weaverFieldDefs: defs, weaverFieldDefsBuildType: buildType })
  },

  loadWeaverFields: async (sessionId) => {
    try {
      const fields = await api.getFields(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverFields: fields, weaverStateSessionId: sessionId })
    } catch {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverFields: [] })
    }
  },

  renderWeaverFields: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) return
    // Render All leaves committed fields (hand-edited or accepted) untouched, so the
    // optimistic spinner only covers the fields the server will actually re-roll.
    const locked = new Set(
      get().weaverFields
        .filter((f) => f.status === 'manually_edited' || f.provenance.accepted === true)
        .map((f) => f.field_name),
    )
    const renderingAll = get().weaverFieldDefs.map((d) => d.id).filter((id) => !locked.has(id))
    set({ weaverRenderError: null, weaverFieldRendering: renderingAll })
    try {
      const fields = await api.renderFields(sessionId)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => ({
        weaverFields: fields,
        weaverStateSessionId: sessionId,
        weaverSessions: state.weaverSessions.map((s) =>
          s.id === sessionId ? { ...s, stage: 'render' } : s,
        ),
      }))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      try {
        const fields = await api.getFields(sessionId)
        if (get().activeWeaverSessionId !== sessionId) return
        if (fields.length > 0) {
          set({ weaverFields: fields, weaverStateSessionId: sessionId })
        } else {
          set({ weaverRenderError: errorMessage(err) })
        }
      } catch {
        if (get().activeWeaverSessionId !== sessionId) return
        set({ weaverRenderError: errorMessage(err) })
      }
    } finally {
      if (get().activeWeaverSessionId === sessionId) set({ weaverFieldRendering: [] })
    }
  },

  renderWeaverField: async (sessionId, fieldId, force = false) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set((state) => ({
      weaverRenderError: null,
      weaverFieldRendering: state.weaverFieldRendering.includes(fieldId)
        ? state.weaverFieldRendering
        : [...state.weaverFieldRendering, fieldId],
    }))
    try {
      const field = await api.renderField(sessionId, fieldId, force)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => upsertRenderedField(state, sessionId, fieldId, field))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverRenderError: errorMessage(err) })
    } finally {
      if (get().activeWeaverSessionId === sessionId) {
        set((state) => ({
          weaverFieldRendering: state.weaverFieldRendering.filter((id) => id !== fieldId),
        }))
      }
    }
  },

  editWeaverField: async (sessionId, fieldId, content) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverRenderError: null })
    try {
      const field = await api.editField(sessionId, fieldId, content)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => upsertRenderedField(state, sessionId, fieldId, field))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverRenderError: errorMessage(err) })
    }
  },

  acceptWeaverField: async (sessionId, fieldId, accepted) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set({ weaverRenderError: null })
    try {
      const field = await api.acceptField(sessionId, fieldId, accepted)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => upsertRenderedField(state, sessionId, fieldId, field))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverRenderError: errorMessage(err) })
    }
  },

  nudgeWeaverField: async (sessionId, fieldId, nudge, force = false) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set((state) => ({
      weaverRenderError: null,
      weaverFieldRendering: state.weaverFieldRendering.includes(fieldId)
        ? state.weaverFieldRendering
        : [...state.weaverFieldRendering, fieldId],
    }))
    try {
      const field = await api.nudgeField(sessionId, fieldId, nudge, force)
      if (get().activeWeaverSessionId !== sessionId) return
      set((state) => upsertRenderedField(state, sessionId, fieldId, field))
    } catch (err) {
      if (get().activeWeaverSessionId !== sessionId) return
      set({ weaverRenderError: errorMessage(err) })
    } finally {
      if (get().activeWeaverSessionId === sessionId) {
        set((state) => ({
          weaverFieldRendering: state.weaverFieldRendering.filter((id) => id !== fieldId),
        }))
      }
    }
  },

  finalizeWeaver: async (sessionId, input) => {
    if (get().activeWeaverSessionId !== sessionId) throw new Error('Cannot finalize a session that is not open')
    set({ weaverFinalizing: true, weaverFinalizeError: null })
    try {
      const result = await api.finalizeSession(sessionId, input)
      if (get().activeWeaverSessionId !== sessionId) return result
      set((state) => ({
        weaverFinalizeResult: result,
        weaverStateSessionId: sessionId,
        weaverSessions: state.weaverSessions.map((s) =>
          s.id === sessionId
            ? { ...s, stage: 'finalize', status: 'finalized', character_id: result.character.id, persona_id: result.persona_id }
            : s,
        ),
      }))
      return result
    } catch (err) {
      if (get().activeWeaverSessionId === sessionId) set({ weaverFinalizeError: errorMessage(err) })
      throw err
    } finally {
      if (get().activeWeaverSessionId === sessionId) set({ weaverFinalizing: false })
    }
  },

  startWeaverChat: async (sessionId) => {
    if (get().activeWeaverSessionId !== sessionId) throw new Error('Cannot start a chat for a session that is not open')
    set({ weaverStartingChat: true, weaverFinalizeError: null })
    try {
      const result = await api.startChat(sessionId)
      const personaId = get().weaverSessions.find((s) => s.id === sessionId)?.persona_id
      if (personaId) get().setActivePersona(personaId)
      if (get().activeWeaverSessionId === sessionId) {
        set((state) => ({
          weaverSessions: state.weaverSessions.map((s) =>
            s.id === sessionId ? { ...s, launch_chat_id: result.chat.id } : s,
          ),
        }))
      }
      return result
    } catch (err) {
      if (get().activeWeaverSessionId === sessionId) set({ weaverFinalizeError: errorMessage(err) })
      throw err
    } finally {
      if (get().activeWeaverSessionId === sessionId) set({ weaverStartingChat: false })
    }
  },

  setWeaverPersonaDraft: (draft) => set({ weaverPersonaDraft: draft }),

  setWeaverPersonaPlan: async (sessionId, plan) => {
    if (get().activeWeaverSessionId !== sessionId) return
    set((state) => ({
      weaverSessions: state.weaverSessions.map((s) =>
        s.id === sessionId ? { ...s, persona_plan: plan } : s,
      ),
    }))
    const updated = await api.updateSession(sessionId, { persona_plan: plan })
    if (get().activeWeaverSessionId === sessionId) {
      set((state) => ({ weaverSessions: replaceSession(state.weaverSessions, updated) }))
    }
  },

  generateWeaverPersona: async (sessionId) => {
    set({ weaverPersonaGenerating: true, weaverPersonaError: null })
    try {
      const draft = await api.generatePersonaDraft(sessionId)
      if (get().activeWeaverSessionId === sessionId) set({ weaverPersonaDraft: draft })
      return draft
    } catch (err) {
      if (get().activeWeaverSessionId === sessionId) set({ weaverPersonaError: errorMessage(err) })
      throw err
    } finally {
      if (get().activeWeaverSessionId === sessionId) set({ weaverPersonaGenerating: false })
    }
  },

  generateWeaverPersonaGreeting: async (sessionId, draft, register) => {
    set({ weaverPersonaGreetingGenerating: true, weaverPersonaError: null })
    try {
      const { greeting } = await api.generatePersonaGreeting(sessionId, draft, register)
      return greeting
    } catch (err) {
      if (get().activeWeaverSessionId === sessionId) set({ weaverPersonaError: errorMessage(err) })
      throw err
    } finally {
      if (get().activeWeaverSessionId === sessionId) set({ weaverPersonaGreetingGenerating: false })
    }
  },
})
