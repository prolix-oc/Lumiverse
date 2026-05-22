import { useCallback, useEffect, useId, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import { dreamWeaverApi, type DreamWeaverDraft } from '@/api/dream-weaver'
import { useDreamWeaverStudio, type TabId } from './hooks/useDreamWeaverStudio'
import { useVisualStudio } from './hooks/useVisualStudio'
import { toast } from '@/lib/toast'
import { StudioTab } from './tabs/StudioTab'
import { VisualsTab } from './tabs/VisualsTab'
import { useProgressTracker } from './hooks/useProgressTracker'
import styles from './DreamWeaverStudio.module.css'

const EMPTY_VOICE_GUIDANCE = {
  compiled: '',
  rules: { baseline: [], rhythm: [], diction: [], quirks: [], hard_nos: [] },
}

function workspaceToV1(draft: any): DreamWeaverDraft | null {
  if (!draft) return null
  return {
    format: 'DW_DRAFT_V1',
    version: 1,
    kind: draft.kind === 'scenario' ? 'scenario' : 'character',
    meta: { title: draft.name ?? '', summary: '', tags: [], content_rating: 'sfw' },
    card: {
      name: draft.name ?? '',
      appearance: draft.appearance ?? '',
      appearance_data: (draft.appearance_data ?? {}) as Record<string, string>,
      description: draft.appearance ?? '',
      personality: draft.personality ?? '',
      scenario: draft.scenario ?? '',
      first_mes: draft.first_mes ?? '',
      system_prompt: '',
      post_history_instructions: '',
    },
    voice_guidance: draft.voice_guidance ?? EMPTY_VOICE_GUIDANCE,
    alternate_fields: { description: [], personality: [], scenario: [] },
    greetings: draft.greeting
      ? [{ id: 'greeting-0', label: 'Greeting', content: draft.greeting }]
      : [],
    lorebooks: draft.lorebooks ?? [],
    npc_definitions: draft.npcs ?? [],
    regex_scripts: [],
    visual_assets: draft.visual_assets,
  }
}

interface DreamWeaverStudioProps {
  sessionId: string
}

const TAB_LABELS: Record<TabId, string> = { studio: 'Studio', visuals: 'Visuals' }
const TABS: { id: TabId; label: string }[] = (['studio', 'visuals'] as TabId[]).map((id) => ({
  id,
  label: TAB_LABELS[id],
}))

export function DreamWeaverStudio({ sessionId }: DreamWeaverStudioProps) {
  const closeModal = useStore((s) => s.closeModal)

  const studio = useDreamWeaverStudio(sessionId)
  const draftV1 = useMemo(() => workspaceToV1(studio.draft), [studio.draft])
  const workspaceKind = studio.session?.workspace_kind === 'scenario' ? 'scenario' : 'character'
  const progressFields = useProgressTracker(studio.draft, workspaceKind)
  const finalizeHelpId = useId()
  const isFinalized = Boolean(studio.session?.character_id)
  const hasSource = Boolean(
    studio.session?.dream_text?.trim()
      || studio.draft?.sources?.some((source) => source.content.trim()),
  )
  const missingFinalizeFields = getMissingFinalizeFields(studio.draft, workspaceKind)
  const finalizeLabel = isFinalized
    ? `Update ${workspaceKind === 'scenario' ? 'Scenario' : 'Character'}`
    : `Finalize ${workspaceKind === 'scenario' ? 'Scenario' : 'Character'}`
  const statusLabel = isFinalized ? 'Linked' : 'Draft'
  const footerStatus = isFinalized
    ? 'Updates the existing generated card.'
    : 'Creates a new card when finalized.'
  const missingFinalizeMessage = missingFinalizeFields.length > 0
    ? `Needs ${formatMissingFields(missingFinalizeFields)} before finalizing.`
    : null
  const handleVisualDraftUpdate = useCallback((patch: Partial<DreamWeaverDraft>) => {
    if (!patch.visual_assets) return
    void dreamWeaverApi.updateVisualAssets(sessionId, patch.visual_assets).catch((error: unknown) => {
      console.error('Failed to persist Dream Weaver visual assets', error)
      toast.error('Failed to save visual settings. Try again before finalizing.', { title: 'Dream Weaver' })
    })
  }, [sessionId])
  const visuals = useVisualStudio(sessionId, draftV1, handleVisualDraftUpdate)

  const prevFinalized = useRef(isFinalized)
  useEffect(() => {
    if (!prevFinalized.current && isFinalized) {
      toast.success(
        `${workspaceKind === 'scenario' ? 'Scenario' : 'Character'} created. You can now open it in chat.`,
        { title: 'Dream Weaver' },
      )
    }
    prevFinalized.current = isFinalized
  }, [isFinalized, workspaceKind])

  const handleClose = useCallback(() => {
    closeModal()
  }, [closeModal])

  const handleTabChange = useCallback((tab: TabId) => {
    studio.setActiveTab(tab)
  }, [studio])

  const handleFinalize = useCallback(() => {
    if (missingFinalizeFields.length > 0) {
      toast.warning(`Add ${formatMissingFields(missingFinalizeFields)} before finalizing.`, { title: 'Dream Weaver' })
      return
    }

    void studio.finalize({
      accepted_portrait_image_id: visuals.selectedAsset?.references[0]?.image_id ?? null,
    })
  }, [missingFinalizeFields, studio, visuals.selectedAsset?.references])

  return createPortal(
    <>
      <div className={styles.overlay} onClick={handleClose}>
        <motion.div
          className={styles.studio}
          onClick={(event) => event.stopPropagation()}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.15 }}
        >
          {studio.loading ? (
            <div className={styles.loadingState}>
              <Spinner />
              <p>Loading session...</p>
            </div>
          ) : (
            <>
              <header className={styles.header}>
                <div className={styles.headerLeft}>
                  <span className={styles.headerLabel}>Dream Weaver Studio</span>
                  <h2 className={styles.headerTitle}>
                    {sessionDisplayName(studio.draft, studio.session)}
                  </h2>
                </div>
                <div className={styles.headerRight}>
                  <div className={styles.kindToggle} aria-label="Card type">
                    {(['character', 'scenario'] as const).map((kind) => (
                      <button
                        key={kind}
                        type="button"
                        className={styles.kindButton}
                        data-active={studio.session?.workspace_kind === kind || undefined}
                        onClick={() => void studio.updateWorkspaceKind(kind)}
                        disabled={Boolean(studio.session?.character_id)}
                      >
                        {kind === 'character' ? 'Character' : 'Scenario'}
                      </button>
                    ))}
                  </div>
                  <div className={styles.badges}>
                    <span className={styles.badge} data-state={isFinalized ? 'linked' : undefined}>
                      {statusLabel}
                    </span>
                  </div>
                  <CloseButton onClick={handleClose} />
                </div>
              </header>

              <div className={styles.body}>
                <div className={styles.main}>
                  <nav className={styles.tabBar}>
                    {TABS.map((tab) => (
                      <button
                        key={tab.id}
                        className={styles.tab}
                        data-active={studio.activeTab === tab.id || undefined}
                        onClick={() => handleTabChange(tab.id)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </nav>

                  <div className={styles.canvas}>
                    {studio.activeTab === 'studio' && (
                      <StudioTab sessionId={sessionId} hasSource={hasSource} workspaceKind={workspaceKind} progressFields={progressFields} onWorkspaceChanged={studio.refreshDraft} />
                    )}
                    {studio.activeTab === 'visuals' && (
                      <VisualsTab draft={draftV1} worldStale={false} visuals={visuals} />
                    )}
                  </div>
                </div>
              </div>

              <footer className={styles.footer}>
                <div className={styles.footerLeft}>
                  <span className={styles.sessionName}>
                    {sessionDisplayName(studio.draft, studio.session)}
                  </span>
                  <span className={styles.saveStatus} data-dirty={!isFinalized || undefined}>
                    {footerStatus}
                  </span>
                  {missingFinalizeMessage && (
                    <span id={finalizeHelpId} className={styles.missingFields}>
                      {missingFinalizeMessage}
                    </span>
                  )}
                </div>
                <div className={styles.footerRight}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClose}
                    disabled={studio.finalizing}
                  >
                    Close
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={handleFinalize}
                    loading={studio.finalizing}
                    disabled={studio.finalizing || missingFinalizeFields.length > 0}
                    aria-describedby={missingFinalizeMessage ? finalizeHelpId : undefined}
                    title={missingFinalizeFields.length > 0 ? `Needs: ${formatMissingFields(missingFinalizeFields)}` : undefined}
                  >
                    {finalizeLabel}
                  </Button>
                </div>
              </footer>

              {studio.errorMessage && (
                <div className={styles.errorBanner}>
                  <span>{studio.errorMessage}</span>
                  <button onClick={studio.dismissError}>x</button>
                </div>
              )}
            </>
          )}
        </motion.div>
      </div>
    </>,
    document.body,
  )
}

function sessionDisplayName(
  _draft: ReturnType<typeof useDreamWeaverStudio>['draft'],
  session: ReturnType<typeof useDreamWeaverStudio>['session'],
): string {
  if (session) {
    return session.session_number > 0 ? `Session #${session.session_number}` : 'Session'
  }
  return 'New Dream'
}

function getMissingFinalizeFields(
  draft: ReturnType<typeof useDreamWeaverStudio>['draft'],
  workspaceKind: 'character' | 'scenario',
): string[] {
  if (!draft) return ['a name/title', 'personality', 'first message']

  const missing: string[] = []
  if (!draft.name?.trim()) missing.push(workspaceKind === 'scenario' ? 'a title' : 'a name')
  if (!draft.personality?.trim()) missing.push('personality')
  if (!draft.first_mes?.trim()) missing.push('first message')
  return missing
}

function formatMissingFields(fields: string[]): string {
  if (fields.length <= 1) return fields[0] ?? 'required fields'
  if (fields.length === 2) return `${fields[0]} and ${fields[1]}`
  return `${fields.slice(0, -1).join(', ')}, and ${fields[fields.length - 1]}`
}
