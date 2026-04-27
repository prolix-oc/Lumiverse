import { useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import type { DreamWeaverDraft } from '@/api/dream-weaver'
import { useDreamWeaverStudio, type TabId } from './hooks/useDreamWeaverStudio'
import { useVisualStudio } from './hooks/useVisualStudio'
import { StudioTab } from './tabs/StudioTab'
import { VisualsTab } from './tabs/VisualsTab'
import styles from './DreamWeaverStudio.module.css'

const EMPTY_VOICE_GUIDANCE = {
  compiled: '',
  rules: { baseline: [], rhythm: [], diction: [], quirks: [], hard_nos: [] },
}

function draftV2ToV1(draft: any): DreamWeaverDraft | null {
  if (!draft) return null
  return {
    format: 'DW_DRAFT_V1',
    version: 1,
    kind: 'character',
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
  const draftV1 = useMemo(() => draftV2ToV1(studio.draft), [studio.draft])
  const visuals = useVisualStudio(sessionId, draftV1, () => {})

  const handleClose = useCallback(() => {
    closeModal()
  }, [closeModal])

  const handleTabChange = useCallback((tab: TabId) => {
    studio.setActiveTab(tab)
  }, [studio])

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
                    {studio.draft?.name || 'New Dream'}
                  </h2>
                </div>
                <div className={styles.headerRight}>
                  <div className={styles.badges}>
                    <span className={styles.badge}>
                      {studio.session?.character_id ? 'Finalized' : 'Draft'}
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
                    {studio.activeTab === 'studio' && <StudioTab sessionId={sessionId} />}
                    {studio.activeTab === 'visuals' && (
                      <VisualsTab draft={studio.draft} worldStale={false} visuals={visuals} />
                    )}
                  </div>
                </div>
              </div>

              <footer className={styles.footer}>
                <div className={styles.footerLeft}>
                  <span className={styles.sessionName}>
                    {studio.draft?.name || studio.session?.dream_text?.slice(0, 40) || 'Untitled'}
                  </span>
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
                    onClick={studio.finalize}
                    loading={studio.finalizing}
                    disabled={studio.finalizing}
                  >
                    Finalize
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
