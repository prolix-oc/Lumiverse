import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import clsx from 'clsx'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Save,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { dreamWeaverApi, type DreamWeaverAlternateField, type DreamWeaverDraft, type DreamWeaverGreeting, type DreamWeaverSession } from '@/api/dream-weaver'
import { charactersApi } from '@/api/characters'
import { personasApi } from '@/api/personas'
import { connectionsApi } from '@/api/connections'
import { chatsApi } from '@/api/chats'
import { CloseButton } from '@/components/shared/CloseButton'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { Button } from '@/components/shared/FormComponents'
import { ModalShell } from '@/components/shared/ModalShell'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { generateUUID } from '@/lib/uuid'
import { toast } from '@/lib/toast'
import { useStore } from '@/store'
import type { ConnectionProfile, Persona } from '@/types/api'
import styles from './DreamWeaverStudioModal.module.css'

type SectionId =
  | 'dream'
  | 'identity'
  | 'presence'
  | 'opening'
  | 'voice'
  | 'alternates'
  | 'greetings'

type DraftFieldKey = 'description' | 'personality' | 'scenario'

const EMPTY_DRAFT: DreamWeaverDraft = {
  format: 'DW_DRAFT_V1',
  version: 1,
  kind: 'character',
  meta: {
    title: '',
    summary: '',
    tags: [],
    content_rating: 'sfw',
  },
  card: {
    name: '',
    appearance: '',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    system_prompt: '',
    post_history_instructions: '',
  },
  voice_guidance: {
    compiled: '',
    rules: {
      baseline: [],
      rhythm: [],
      diction: [],
      quirks: [],
      hard_nos: [],
    },
  },
  alternate_fields: {
    description: [],
    personality: [],
    scenario: [],
  },
  greetings: [],
  lorebooks: [],
  npc_definitions: [],
  regex_scripts: [],
}

function normalizeAltFields(value: unknown): DreamWeaverAlternateField[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => {
    const next = entry as Partial<DreamWeaverAlternateField> | null
    return {
      id: next?.id || generateUUID(),
      label: next?.label?.trim() || `Variant ${index + 1}`,
      content: next?.content || '',
    }
  })
}

function normalizeGreetings(value: unknown): DreamWeaverGreeting[] {
  if (!Array.isArray(value)) return []
  return value.map((entry, index) => {
    const next = entry as Partial<DreamWeaverGreeting> | null
    return {
      id: next?.id || generateUUID(),
      label: next?.label?.trim() || `Greeting ${index + 1}`,
      content: next?.content || '',
    }
  })
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item ?? '').trim()).filter(Boolean)
}

function normalizeDraft(value: Partial<DreamWeaverDraft> | null | undefined): DreamWeaverDraft {
  const next = value || {}
  const meta = next.meta || EMPTY_DRAFT.meta
  const card = next.card || EMPTY_DRAFT.card
  const voice = next.voice_guidance || EMPTY_DRAFT.voice_guidance
  const rules = voice.rules || EMPTY_DRAFT.voice_guidance.rules
  const alternateFields = next.alternate_fields || EMPTY_DRAFT.alternate_fields

  return {
    format: 'DW_DRAFT_V1',
    version: 1,
    kind: next.kind === 'scenario' ? 'scenario' : 'character',
    meta: {
      title: meta.title || '',
      summary: meta.summary || '',
      tags: normalizeStringArray(meta.tags),
      content_rating: meta.content_rating === 'nsfw' ? 'nsfw' : 'sfw',
    },
    card: {
      name: card.name || '',
      appearance: card.appearance || '',
      description: card.description || '',
      personality: card.personality || '',
      scenario: card.scenario || '',
      first_mes: card.first_mes || '',
      system_prompt: card.system_prompt || '',
      post_history_instructions: card.post_history_instructions || '',
    },
    voice_guidance: {
      compiled: voice.compiled || '',
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
  }
}

function parseStoredDraft(rawDraft: string | null): DreamWeaverDraft | null {
  if (!rawDraft) return null
  try {
    return normalizeDraft(JSON.parse(rawDraft))
  } catch {
    return null
  }
}

function listToTextarea(value: string[]): string {
  return value.join('\n')
}

function textareaToList(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function tagsToInput(value: string[]): string {
  return value.join(', ')
}

function inputToTags(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function countAlternates(draft: DreamWeaverDraft | null): number {
  if (!draft) return 0
  return (
    draft.alternate_fields.description.length +
    draft.alternate_fields.personality.length +
    draft.alternate_fields.scenario.length
  )
}

function strandSummary(id: SectionId, draft: DreamWeaverDraft | null, session: DreamWeaverSession | null): string {
  switch (id) {
    case 'dream':
      return session?.dream_text ? 'Vision and re-weave settings.' : 'Set the dream prompt first.'
    case 'identity':
      return draft ? `${draft.kind} / ${draft.meta.content_rating.toUpperCase()} / ${draft.meta.tags.length} tags` : 'Available after the first weave.'
    case 'presence':
      return draft ? 'Name, appearance, description, personality, and scenario.' : 'Available after the first weave.'
    case 'opening':
      return draft ? 'Opening message plus prompt scaffolding.' : 'Available after the first weave.'
    case 'voice':
      return draft ? `${draft.voice_guidance.rules.baseline.length + draft.voice_guidance.rules.quirks.length} rule lines visible.` : 'Available after the first weave.'
    case 'alternates':
      return draft ? `${countAlternates(draft)} alternate variants across card fields.` : 'Available after the first weave.'
    case 'greetings':
      return draft ? `${draft.greetings.length} greeting${draft.greetings.length === 1 ? '' : 's'} ready.` : 'Available after the first weave.'
    default:
      return ''
  }
}

function buildSessionPayload(
  session: DreamWeaverSession,
  draft: DreamWeaverDraft | null,
  fallbackPersonaId: string | null,
  fallbackConnectionId: string | null,
) {
  return {
    dream_text: session.dream_text,
    tone: session.tone,
    constraints: session.constraints,
    dislikes: session.dislikes,
    persona_id: session.persona_id ?? fallbackPersonaId,
    connection_id: session.connection_id ?? fallbackConnectionId,
    model: session.model,
    draft,
  }
}

function StrandSection({
  title,
  sectionId,
  summary,
  activeSection,
  onToggle,
  children,
}: {
  title: string
  sectionId: SectionId
  summary: string
  activeSection: SectionId
  onToggle: (id: SectionId) => void
  children: ReactNode
}) {
  const isOpen = activeSection === sectionId

  return (
    <section className={clsx(styles.strand, isOpen && styles.strandOpen)}>
      <button type="button" className={styles.strandToggle} onClick={() => onToggle(sectionId)}>
        <div className={styles.strandCopy}>
          <span className={styles.strandTitle}>{title}</span>
          <span className={styles.strandSummary}>{summary}</span>
        </div>
        <span className={styles.strandChevron}>
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {isOpen && <div className={styles.strandBody}>{children}</div>}
    </section>
  )
}

function Field({
  label,
  hint,
  children,
  grow = false,
}: {
  label: string
  hint?: string
  children: ReactNode
  grow?: boolean
}) {
  return (
    <label className={clsx(styles.field, grow && styles.fieldGrow)}>
      <span className={styles.fieldLabel}>{label}</span>
      {hint && <span className={styles.fieldHint}>{hint}</span>}
      {children}
    </label>
  )
}

function RuleEditor({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <Field label={label} hint={hint}>
      <textarea
        className={styles.textarea}
        rows={4}
        value={listToTextarea(value)}
        onChange={(event) => onChange(textareaToList(event.target.value))}
      />
    </Field>
  )
}

function VariantListEditor({
  title,
  helper,
  items,
  onChange,
  addLabel,
}: {
  title: string
  helper: string
  items: Array<DreamWeaverAlternateField | DreamWeaverGreeting>
  onChange: (next: Array<DreamWeaverAlternateField | DreamWeaverGreeting>) => void
  addLabel: string
}) {
  const handleItemChange = (id: string, patch: Partial<DreamWeaverAlternateField | DreamWeaverGreeting>) => {
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  const handleAdd = () => {
    onChange([
      ...items,
      {
        id: generateUUID(),
        label: addLabel,
        content: '',
      },
    ])
  }

  const handleRemove = (id: string) => {
    onChange(items.filter((item) => item.id !== id))
  }

  return (
    <div className={styles.variantSection}>
      <div className={styles.variantSectionHeader}>
        <div>
          <h4 className={styles.variantTitle}>{title}</h4>
          <p className={styles.variantHelper}>{helper}</p>
        </div>
        <Button size="sm" variant="ghost" onClick={handleAdd}>
          Add
        </Button>
      </div>

      {items.length === 0 ? (
        <div className={styles.emptyCard}>No entries yet.</div>
      ) : (
        <div className={styles.variantList}>
          {items.map((item, index) => (
            <div key={item.id} className={styles.variantCard}>
              <div className={styles.variantCardHeader}>
                <span className={styles.variantIndex}>{index + 1}</span>
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => handleRemove(item.id)}
                >
                  Remove
                </button>
              </div>

              <Field label="Label">
                <input
                  className={styles.input}
                  type="text"
                  value={item.label}
                  onChange={(event) => handleItemChange(item.id, { label: event.target.value })}
                />
              </Field>

              <Field label="Content">
                <textarea
                  className={styles.textarea}
                  rows={5}
                  value={item.content}
                  onChange={(event) => handleItemChange(item.id, { content: event.target.value })}
                />
              </Field>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DreamWeaverStudioModal() {
  const closeModal = useStore((s) => s.closeModal)
  const modalProps = useStore((s) => s.modalProps)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeProfileId = useStore((s) => s.activeProfileId)
  const storedPersonas = useStore((s) => s.personas)
  const storedProfiles = useStore((s) => s.profiles)
  const addCharacter = useStore((s) => s.addCharacter)
  const setEditingCharacterId = useStore((s) => s.setEditingCharacterId)

  const navigate = useNavigate()
  const sessionId = modalProps.sessionId as string | undefined

  const [session, setSession] = useState<DreamWeaverSession | null>(null)
  const [draft, setDraft] = useState<DreamWeaverDraft | null>(null)
  const [personas, setPersonas] = useState<Persona[]>(storedPersonas)
  const [connections, setConnections] = useState<ConnectionProfile[]>(storedProfiles)
  const [connectionModels, setConnectionModels] = useState<string[]>([])
  const [connectionModelLabels, setConnectionModelLabels] = useState<Record<string, string>>({})
  const [connectionModelsLoading, setConnectionModelsLoading] = useState(false)
  const [activeSection, setActiveSection] = useState<SectionId>('dream')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmClose, setConfirmClose] = useState(false)
  const [confirmRegenerate, setConfirmRegenerate] = useState(false)
  const [finalizedCharacterId, setFinalizedCharacterId] = useState<string | null>(null)

  useEffect(() => {
    setPersonas(storedPersonas)
  }, [storedPersonas])

  useEffect(() => {
    setConnections(storedProfiles)
  }, [storedProfiles])

  useEffect(() => {
    if (!sessionId) return

    let cancelled = false
    setLoading(true)
    setErrorMessage(null)

    Promise.allSettled([
      dreamWeaverApi.getSession(sessionId),
      personasApi.list({ limit: 200 }),
      connectionsApi.list({ limit: 200 }),
    ])
      .then((results) => {
        if (cancelled) return

        const [sessionResult, personaResult, connectionResult] = results

        if (sessionResult.status !== 'fulfilled') {
          throw sessionResult.reason
        }

        const nextSession = sessionResult.value
        const parsedDraft = parseStoredDraft(nextSession.draft)

        setSession(nextSession)
        setDraft(parsedDraft)
        setFinalizedCharacterId(nextSession.character_id)
        setActiveSection(parsedDraft ? 'identity' : 'dream')
        setDirty(false)

        if (nextSession.draft && !parsedDraft) {
          setErrorMessage('The stored Dream Weaver draft could not be parsed. You can regenerate it from the session inputs.')
        }

        if (personaResult.status === 'fulfilled') {
          setPersonas(personaResult.value.data)
        }

        if (connectionResult.status === 'fulfilled') {
          setConnections(connectionResult.value.data)
        }
      })
      .catch((error: any) => {
        if (cancelled) return
        const message = error?.body?.error || error?.message || 'Failed to load Dream Weaver session'
        setErrorMessage(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sessionId])

  const effectivePersonaId = session?.persona_id ?? activePersonaId ?? null
  const effectiveConnectionId = session?.connection_id ?? activeProfileId ?? null

  const fetchConnectionModels = useCallback(async () => {
    if (!effectiveConnectionId) {
      setConnectionModels([])
      setConnectionModelLabels({})
      return
    }

    setConnectionModelsLoading(true)
    try {
      const result = await connectionsApi.models(effectiveConnectionId)
      setConnectionModels(result.models || [])
      setConnectionModelLabels(result.model_labels || {})
    } catch {
      setConnectionModels([])
      setConnectionModelLabels({})
    } finally {
      setConnectionModelsLoading(false)
    }
  }, [effectiveConnectionId])

  useEffect(() => {
    void fetchConnectionModels()
  }, [fetchConnectionModels])

  const sessionDetail = useMemo(() => {
    if (!session) return ''

    const parts = [new Date(session.updated_at * 1000).toLocaleString()]
    const personaName = personas.find((persona) => persona.id === effectivePersonaId)?.name
    const connectionName = connections.find((connection) => connection.id === effectiveConnectionId)?.name
    const modelName = session.model?.trim()

    if (personaName) parts.push(personaName)
    if (connectionName) parts.push(connectionName)
    if (modelName) parts.push(modelName)

    return parts.join('  •  ')
  }, [connections, effectiveConnectionId, effectivePersonaId, personas, session])

  const updateSessionField = useCallback(
    <K extends keyof DreamWeaverSession>(field: K, value: DreamWeaverSession[K]) => {
      setSession((current) => (current ? { ...current, [field]: value } : current))
      setDirty(true)
    },
    [],
  )

  const updateDraftState = useCallback((updater: (current: DreamWeaverDraft) => DreamWeaverDraft) => {
    setDraft((current) => (current ? normalizeDraft(updater(current)) : current))
    setDirty(true)
  }, [])

  const updateMetaField = useCallback(
    <K extends keyof DreamWeaverDraft['meta']>(field: K, value: DreamWeaverDraft['meta'][K]) => {
      updateDraftState((current) => ({
        ...current,
        meta: {
          ...current.meta,
          [field]: value,
        },
      }))
    },
    [updateDraftState],
  )

  const updateCardField = useCallback(
    <K extends keyof DreamWeaverDraft['card']>(field: K, value: DreamWeaverDraft['card'][K]) => {
      updateDraftState((current) => ({
        ...current,
        card: {
          ...current.card,
          [field]: value,
        },
      }))
    },
    [updateDraftState],
  )

  const updateVoiceCompiled = useCallback(
    (value: string) => {
      updateDraftState((current) => ({
        ...current,
        voice_guidance: {
          ...current.voice_guidance,
          compiled: value,
        },
      }))
    },
    [updateDraftState],
  )

  const updateVoiceRule = useCallback(
    (rule: keyof DreamWeaverDraft['voice_guidance']['rules'], value: string[]) => {
      updateDraftState((current) => ({
        ...current,
        voice_guidance: {
          ...current.voice_guidance,
          rules: {
            ...current.voice_guidance.rules,
            [rule]: value,
          },
        },
      }))
    },
    [updateDraftState],
  )

  const updateAlternateField = useCallback(
    (field: DraftFieldKey, value: DreamWeaverAlternateField[]) => {
      updateDraftState((current) => ({
        ...current,
        alternate_fields: {
          ...current.alternate_fields,
          [field]: value,
        },
      }))
    },
    [updateDraftState],
  )

  const saveSession = useCallback(
    async (silent = false) => {
      if (!session) return null

      const needsFallbackPersistence =
        (session.persona_id ?? null) !== effectivePersonaId ||
        (session.connection_id ?? null) !== effectiveConnectionId

      if (!dirty && !needsFallbackPersistence) {
        return session
      }

      setSaving(true)
      setErrorMessage(null)

      try {
        const updated = await dreamWeaverApi.updateSession(
          session.id,
          buildSessionPayload(session, draft, effectivePersonaId, effectiveConnectionId),
        )

        setSession(updated)
        setDraft(updated.draft ? parseStoredDraft(updated.draft) : null)
        setDirty(false)

        if (!silent) {
          toast.success('Dream Weaver changes saved', { title: 'Dream Weaver' })
        }

        return updated
      } catch (error: any) {
        const message = error?.body?.error || error?.message || 'Failed to save Dream Weaver session'
        setErrorMessage(message)
        toast.error(message, { title: 'Dream Weaver' })
        return null
      } finally {
        setSaving(false)
      }
    },
    [dirty, draft, effectiveConnectionId, effectivePersonaId, session],
  )

  const runGeneration = useCallback(async () => {
    if (!session) return

    const savedSession = await saveSession(true)
    if (!savedSession) return

    setGenerating(true)
    setErrorMessage(null)

    try {
      const generatedSession = await dreamWeaverApi.generateDraft(savedSession.id)
      setSession(generatedSession)
      setActiveSection('identity')
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Dream weaving failed'
      setErrorMessage(message)
      toast.error(message, { title: 'Dream Weaver' })
    } finally {
      setConfirmRegenerate(false)
    }
  }, [saveSession, session])

  const handleGenerate = useCallback(async () => {
    if (draft) {
      setConfirmRegenerate(true)
      return
    }

    await runGeneration()
  }, [draft, runGeneration])

  const handleFinalize = useCallback(async () => {
    if (!session || !draft) return

    const savedSession = await saveSession(true)
    if (!savedSession) return

    setFinalizing(true)
    setErrorMessage(null)

    try {
      const result = await dreamWeaverApi.finalize(savedSession.id)
      const characterId = result.characterId
      setFinalizedCharacterId(characterId)
      setSession((current) =>
        current
          ? {
              ...current,
              character_id: characterId,
              updated_at: Math.floor(Date.now() / 1000),
            }
          : current,
      )

      try {
        const character = await charactersApi.get(characterId)
        addCharacter(character)
      } catch {
        // Finalization already succeeded. Store hydration is only a convenience.
      }

      toast.success('Character created from Dream Weaver', { title: 'Dream Weaver' })
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to finalize Dream Weaver draft'
      setErrorMessage(message)
      toast.error(message, { title: 'Dream Weaver' })
    } finally {
      setFinalizing(false)
    }
  }, [addCharacter, draft, saveSession, session])

  const handleOpenEditor = useCallback(() => {
    if (!finalizedCharacterId) return
    setEditingCharacterId(finalizedCharacterId)
    closeModal()
    navigate('/characters')
  }, [closeModal, finalizedCharacterId, navigate, setEditingCharacterId])

  const handleOpenChat = useCallback(async () => {
    if (!finalizedCharacterId) return

    try {
      const chat = await chatsApi.create({ character_id: finalizedCharacterId })
      closeModal()
      navigate(`/chat/${chat.id}`)
    } catch (error: any) {
      const message = error?.body?.error || error?.message || 'Failed to create chat'
      setErrorMessage(message)
      toast.error(message, { title: 'Dream Weaver' })
    }
  }, [closeModal, finalizedCharacterId, navigate])

  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmClose(true)
      return
    }
    closeModal()
  }, [closeModal, dirty])

  const handleDone = useCallback(async () => {
    if (dirty) {
      const savedSession = await saveSession(true)
      if (!savedSession) return
    }
    closeModal()
  }, [closeModal, dirty, saveSession])

  if (!sessionId) return null

  return (
    <>
      <ModalShell
        isOpen={true}
        onClose={requestClose}
        maxWidth="clamp(320px, 96vw, 1320px)"
        maxHeight="94vh"
        closeOnBackdrop={false}
        zIndex={10001}
        className={styles.modal}
      >
        <div className={styles.shell}>
          <header className={styles.header}>
            <div className={styles.headerCopy}>
              <div className={styles.iconBadge}>
                <Sparkles size={18} />
              </div>
              <div>
                <h2 className={styles.title}>{draft?.card.name || draft?.meta.title || 'Dream Weaver'}</h2>
                {sessionDetail && <p className={styles.subtitle}>{sessionDetail}</p>}
              </div>
            </div>

            <div className={styles.headerActions}>
              <div className={clsx(styles.statusPill, dirty && styles.statusPillDirty)}>
                {dirty ? 'Unsaved changes' : finalizedCharacterId ? 'Character created' : draft ? 'Draft ready' : 'Saved'}
              </div>
              <Button
                size="sm"
                variant={dirty ? 'secondary' : 'ghost'}
                icon={<Save size={14} />}
                onClick={() => void saveSession(false)}
                loading={saving}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleDone()}
              >
                Done
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon={<Wand2 size={14} />}
                onClick={() => void handleGenerate()}
                loading={generating}
                disabled={!session?.dream_text.trim()}
              >
                {draft ? 'Re-weave' : 'Weave'}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                icon={<CheckCircle2 size={14} />}
                onClick={() => void handleFinalize()}
                loading={finalizing}
                disabled={!draft}
              >
                Finalize
              </Button>
              <CloseButton onClick={requestClose} />
            </div>
          </header>

          {errorMessage && (
            <div className={styles.errorBanner} role="alert">
              <AlertCircle size={16} />
              <span>{errorMessage}</span>
            </div>
          )}

          {loading || !session ? (
            <div className={styles.loadingState}>
              <div className={styles.loadingSpinner}>
                <RefreshCw size={18} />
              </div>
              <div>
                <h3 className={styles.loadingTitle}>Loading Dream Weaver session</h3>
                <p className={styles.loadingText}>Pulling the saved draft and studio settings into place.</p>
              </div>
            </div>
          ) : (
            <div className={styles.body}>
              <main className={styles.mainColumn}>
                {finalizedCharacterId && (
                  <div className={styles.finalizedCard}>
                    <div>
                      <h4 className={styles.finalizedTitle}>Character already created</h4>
                      <p className={styles.finalizedText}>
                        This session has already been finalized once. You can reopen the result or keep iterating here.
                      </p>
                    </div>
                    <div className={styles.finalizedActions}>
                      <Button size="sm" variant="secondary" onClick={handleOpenEditor}>
                        Edit Character
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void handleOpenChat()}>
                        Start Chat
                      </Button>
                    </div>
                  </div>
                )}

                <StrandSection
                  title="Dream"
                  sectionId="dream"
                  summary={strandSummary('dream', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  <div className={styles.sectionGrid}>
                    <Field
                      label="Vision"
                      hint="Edit the source prompt here before weaving again."
                      grow={true}
                    >
                      <textarea
                        className={clsx(styles.textarea, styles.visionTextarea)}
                        rows={9}
                        value={session.dream_text}
                        onChange={(event) => updateSessionField('dream_text', event.target.value)}
                        placeholder="Describe the tension, dynamic, history, and angle worth preserving."
                      />
                    </Field>
                  </div>

                  <div className={styles.sectionGrid}>
                    <Field label="Tone" hint="Optional mood and genre pressure for the next weave.">
                      <input
                        className={styles.input}
                        type="text"
                        value={session.tone || ''}
                        onChange={(event) => updateSessionField('tone', event.target.value || null)}
                        placeholder="Uneasy, intimate, grounded, sharp..."
                      />
                    </Field>

                    <Field label="Persona" hint="Optional user persona context for re-weaving.">
                      <select
                        className={styles.select}
                        value={effectivePersonaId || ''}
                        onChange={(event) => updateSessionField('persona_id', event.target.value || null)}
                      >
                        <option value="">No persona</option>
                        {personas.map((persona) => (
                          <option key={persona.id} value={persona.id}>
                            {persona.name}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field label="Connection" hint="Choose a specific model, or stay on the default connection.">
                      <select
                        className={styles.select}
                        value={effectiveConnectionId || ''}
                        onChange={(event) => {
                          updateSessionField('connection_id', event.target.value || null)
                          updateSessionField('model', null)
                        }}
                      >
                        <option value="">Default connection</option>
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>
                            {connection.name}
                          </option>
                        ))}
                      </select>
                    </Field>

                    <Field label="Model" hint="Leave blank to use the selected connection profile's default model.">
                      <ModelCombobox
                        value={session.model || ''}
                        onChange={(value) => updateSessionField('model', value.trim() || null)}
                        models={connectionModels}
                        modelLabels={connectionModelLabels}
                        loading={connectionModelsLoading}
                        onRefresh={fetchConnectionModels}
                        autoRefreshOnFocus
                        refreshKey={effectiveConnectionId || ''}
                        appearance="editor"
                        placeholder="Leave empty to use connection default"
                        emptyMessage={effectiveConnectionId ? 'No models returned for this connection. Enter one manually or leave it blank to use the connection default.' : 'No connection available.'}
                        disabled={!effectiveConnectionId}
                      />
                    </Field>
                  </div>

                  <div className={styles.sectionGrid}>
                    <Field label="Constraints" hint="What must remain true on the next weave." grow={true}>
                      <textarea
                        className={styles.textarea}
                        rows={5}
                        value={session.constraints || ''}
                        onChange={(event) => updateSessionField('constraints', event.target.value || null)}
                        placeholder="Keep the prior history explicit. Preserve the unease. Do not flatten the power dynamic."
                      />
                    </Field>

                    <Field label="Hard No's" hint="Patterns, cliches, or content you want blocked." grow={true}>
                      <textarea
                        className={styles.textarea}
                        rows={5}
                        value={session.dislikes || ''}
                        onChange={(event) => updateSessionField('dislikes', event.target.value || null)}
                        placeholder="No instant forgiveness, no generic tsundere flattening, no flowery prose."
                      />
                    </Field>
                  </div>
                </StrandSection>

                <StrandSection
                  title="Identity"
                  sectionId="identity"
                  summary={strandSummary('identity', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  {!draft ? (
                    <div className={styles.emptyCard}>Generate the first draft to unlock package metadata, naming, tags, and rating.</div>
                  ) : (
                    <>
                      <div className={styles.sectionGrid}>
                        <Field label="Kind" hint="Switch if the draft landed on the wrong package type.">
                          <select
                            className={styles.select}
                            value={draft.kind}
                            onChange={(event) => updateDraftState((current) => ({ ...current, kind: event.target.value === 'scenario' ? 'scenario' : 'character' }))}
                          >
                            <option value="character">Character</option>
                            <option value="scenario">Scenario</option>
                          </select>
                        </Field>

                        <Field label="Content Rating">
                          <select
                            className={styles.select}
                            value={draft.meta.content_rating}
                            onChange={(event) => updateMetaField('content_rating', event.target.value === 'nsfw' ? 'nsfw' : 'sfw')}
                          >
                            <option value="sfw">SFW</option>
                            <option value="nsfw">NSFW</option>
                          </select>
                        </Field>

                        <Field label="Character Name" hint="This is the name that becomes the final character card.">
                          <input
                            className={styles.input}
                            type="text"
                            value={draft.card.name}
                            onChange={(event) => updateCardField('name', event.target.value)}
                          />
                        </Field>
                      </div>

                      <div className={styles.sectionGrid}>
                        <Field label="Package Title" grow={true}>
                          <input
                            className={styles.input}
                            type="text"
                            value={draft.meta.title}
                            onChange={(event) => updateMetaField('title', event.target.value)}
                          />
                        </Field>

                        <Field label="Tags" hint="Comma separated tags.">
                          <input
                            className={styles.input}
                            type="text"
                            value={tagsToInput(draft.meta.tags)}
                            onChange={(event) => updateMetaField('tags', inputToTags(event.target.value))}
                          />
                        </Field>
                      </div>

                      <Field label="Summary" hint="One concise explanation of the package promise.">
                        <textarea
                          className={styles.textarea}
                          rows={4}
                          value={draft.meta.summary}
                          onChange={(event) => updateMetaField('summary', event.target.value)}
                        />
                      </Field>
                    </>
                  )}
                </StrandSection>

                <StrandSection
                  title="Presence"
                  sectionId="presence"
                  summary={strandSummary('presence', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  {!draft ? (
                    <div className={styles.emptyCard}>The presence fields appear after generation so you can shape the card directly.</div>
                  ) : (
                    <>
                      <Field label="Appearance" hint="Keep this grounded and materially useful for the runtime card.">
                        <textarea
                          className={styles.textarea}
                          rows={6}
                          value={draft.card.appearance}
                          onChange={(event) => updateCardField('appearance', event.target.value)}
                        />
                      </Field>

                      <div className={styles.sectionGrid}>
                        <Field label="Description" grow={true}>
                          <textarea
                            className={styles.textarea}
                            rows={6}
                            value={draft.card.description}
                            onChange={(event) => updateCardField('description', event.target.value)}
                          />
                        </Field>

                        <Field label="Personality" grow={true}>
                          <textarea
                            className={styles.textarea}
                            rows={6}
                            value={draft.card.personality}
                            onChange={(event) => updateCardField('personality', event.target.value)}
                          />
                        </Field>
                      </div>

                      <Field label="Scenario" hint="This becomes the scenario field on the final character.">
                        <textarea
                          className={styles.textarea}
                          rows={6}
                          value={draft.card.scenario}
                          onChange={(event) => updateCardField('scenario', event.target.value)}
                        />
                      </Field>
                    </>
                  )}
                </StrandSection>

                <StrandSection
                  title="Opening"
                  sectionId="opening"
                  summary={strandSummary('opening', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  {!draft ? (
                    <div className={styles.emptyCard}>Generate the card first, then refine the opening message and prompt scaffolding here.</div>
                  ) : (
                    <>
                      <Field label="First Message" hint="This becomes the default greeting. Alternate greetings live in the Greetings strand.">
                        <textarea
                          className={styles.textarea}
                          rows={8}
                          value={draft.card.first_mes}
                          onChange={(event) => updateCardField('first_mes', event.target.value)}
                        />
                      </Field>

                      <div className={styles.sectionGrid}>
                        <Field label="System Prompt" grow={true}>
                          <textarea
                            className={styles.textarea}
                            rows={5}
                            value={draft.card.system_prompt}
                            onChange={(event) => updateCardField('system_prompt', event.target.value)}
                          />
                        </Field>

                        <Field label="Post History Instructions" grow={true}>
                          <textarea
                            className={styles.textarea}
                            rows={5}
                            value={draft.card.post_history_instructions}
                            onChange={(event) => updateCardField('post_history_instructions', event.target.value)}
                          />
                        </Field>
                      </div>
                    </>
                  )}
                </StrandSection>

                <StrandSection
                  title="Voice"
                  sectionId="voice"
                  summary={strandSummary('voice', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  {!draft ? (
                    <div className={styles.emptyCard}>Voice guidance is generated alongside the draft and then becomes editable line by line.</div>
                  ) : (
                    <>
                      <Field label="Compiled Voice Guidance" hint="The high-level speech map that can be stored with the final character.">
                        <textarea
                          className={styles.textarea}
                          rows={6}
                          value={draft.voice_guidance.compiled}
                          onChange={(event) => updateVoiceCompiled(event.target.value)}
                        />
                      </Field>

                      <div className={styles.voiceGrid}>
                        <RuleEditor
                          label="Baseline"
                          hint="Core voice rules that should hold most of the time."
                          value={draft.voice_guidance.rules.baseline}
                          onChange={(value) => updateVoiceRule('baseline', value)}
                        />
                        <RuleEditor
                          label="Rhythm"
                          hint="Cadence, sentence flow, and pacing."
                          value={draft.voice_guidance.rules.rhythm}
                          onChange={(value) => updateVoiceRule('rhythm', value)}
                        />
                        <RuleEditor
                          label="Diction"
                          hint="Preferred vocabulary and register."
                          value={draft.voice_guidance.rules.diction}
                          onChange={(value) => updateVoiceRule('diction', value)}
                        />
                        <RuleEditor
                          label="Quirks"
                          hint="Specific habits or expressive tells."
                          value={draft.voice_guidance.rules.quirks}
                          onChange={(value) => updateVoiceRule('quirks', value)}
                        />
                        <RuleEditor
                          label="Hard No's"
                          hint="Speech habits that should not appear in runtime responses."
                          value={draft.voice_guidance.rules.hard_nos}
                          onChange={(value) => updateVoiceRule('hard_nos', value)}
                        />
                      </div>
                    </>
                  )}
                </StrandSection>

                <StrandSection
                  title="Alternates"
                  sectionId="alternates"
                  summary={strandSummary('alternates', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  {!draft ? (
                    <div className={styles.emptyCard}>Alternate field variants appear after the first weave. They can be edited before finalization and will be stored with the character.</div>
                  ) : (
                    <div className={styles.variantStack}>
                      <VariantListEditor
                        title="Description Variants"
                        helper="Alternate takes on the description field."
                        items={draft.alternate_fields.description}
                        onChange={(value) => updateAlternateField('description', value as DreamWeaverAlternateField[])}
                        addLabel="New description variant"
                      />
                      <VariantListEditor
                        title="Personality Variants"
                        helper="Alternate takes on the personality field."
                        items={draft.alternate_fields.personality}
                        onChange={(value) => updateAlternateField('personality', value as DreamWeaverAlternateField[])}
                        addLabel="New personality variant"
                      />
                      <VariantListEditor
                        title="Scenario Variants"
                        helper="Alternate takes on the scenario field."
                        items={draft.alternate_fields.scenario}
                        onChange={(value) => updateAlternateField('scenario', value as DreamWeaverAlternateField[])}
                        addLabel="New scenario variant"
                      />
                    </div>
                  )}
                </StrandSection>

                <StrandSection
                  title="Greetings"
                  sectionId="greetings"
                  summary={strandSummary('greetings', draft, session)}
                  activeSection={activeSection}
                  onToggle={setActiveSection}
                >
                  {!draft ? (
                    <div className={styles.emptyCard}>Greeting editing becomes available after generation.</div>
                  ) : (
                    <VariantListEditor
                      title="Greeting Set"
                      helper="The first message becomes the default greeting. Additional entries become alternate greetings."
                      items={draft.greetings}
                      onChange={(value) => updateDraftState((current) => ({ ...current, greetings: value as DreamWeaverGreeting[] }))}
                      addLabel="New greeting"
                    />
                  )}
                </StrandSection>
              </main>
            </div>
          )}
        </div>
      </ModalShell>

      {confirmClose && (
        <ConfirmationModal
          isOpen={true}
          title="Discard unsaved Dream Weaver edits?"
          message="You have unsaved changes in the Dream Weaver studio. Closing now will throw them away."
          variant="warning"
          confirmText="Discard changes"
          onConfirm={() => {
            setConfirmClose(false)
            closeModal()
          }}
          onCancel={() => setConfirmClose(false)}
        />
      )}

      {confirmRegenerate && (
        <ConfirmationModal
          isOpen={true}
          title="Regenerate this draft?"
          message="Regenerating replaces the current draft with a fresh version from the Dream input fields."
          variant="warning"
          confirmText="Regenerate"
          onConfirm={() => void runGeneration()}
          onCancel={() => setConfirmRegenerate(false)}
        />
      )}
    </>
  )
}
