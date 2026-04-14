import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { CloseButton } from '@/components/shared/CloseButton'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { Button } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import { useDreamWeaverStudio, type TabId } from './hooks/useDreamWeaverStudio'
import { useVisualStudio } from './hooks/useVisualStudio'
import { IconRail } from './components/IconRail'
import { DreamSidePanel } from './components/DreamSidePanel'
import { WeavingOverlay } from './components/WeavingOverlay'
import { SoulTab } from './tabs/SoulTab'
import { WorldTab } from './tabs/WorldTab'
import { VisualsTab } from './tabs/VisualsTab'
import { MAIN_TABS, canFinalize, isWorldStale, shouldOfferOpenChat } from './lib/studio-model'
import styles from './DreamWeaverStudio.module.css'

interface DreamWeaverStudioProps {
  sessionId: string
}

const TAB_LABELS: Record<TabId, string> = {
  soul: 'Soul',
  world: 'World',
  visuals: 'Visuals',
}

const TABS: { id: TabId; label: string }[] = MAIN_TABS.map((id) => ({
  id,
  label: TAB_LABELS[id],
}))

export function DreamWeaverStudio({ sessionId }: DreamWeaverStudioProps) {
  const closeModal = useStore((s) => s.closeModal)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [confirmClose, setConfirmClose] = useState(false)

  const studio = useDreamWeaverStudio(sessionId)
  const visuals = useVisualStudio(sessionId, studio.draft, (patch) => {
    for (const [key, value] of Object.entries(patch)) {
      studio.updateDraftField(key as any, value as any)
    }
  })

  const handleClose = useCallback(() => {
    if (studio.saving || studio.finalizing) return

    if (studio.requestClose()) {
      closeModal()
    } else {
      setConfirmClose(true)
    }
  }, [studio, closeModal])

  const handleConfirmClose = useCallback(async () => {
    await studio.save()
    closeModal()
  }, [studio, closeModal])

  const scrollToSection = useCallback((sectionId: string) => {
    const element = canvasRef.current?.querySelector(`#section-${sectionId}`)
    element?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const openPackageHealth = useCallback(() => {
    studio.setActiveTab('visuals')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToSection('package_health'))
    })
  }, [scrollToSection, studio])

  const handleTabChange = useCallback((tab: TabId) => {
    studio.setActiveTab(tab)
  }, [studio])

  const contentRating = studio.draft?.meta?.content_rating ?? 'sfw'
  const kind = studio.draft?.kind
  const showOpenChat = shouldOfferOpenChat(studio.session)
  const showWeavingCanvas = studio.generating

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
                    {studio.draft?.card?.name || 'New Dream'}
                  </h2>
                </div>
                <div className={styles.headerRight}>
                  <div className={styles.badges}>
                    <span className={styles.badge}>
                      {studio.dirty ? 'Unsaved' : studio.draft?.card?.name ? 'Draft Ready' : 'New'}
                    </span>
                    <span className={styles.badge} data-rating={contentRating}>
                      {contentRating.toUpperCase()}
                    </span>
                  </div>
                  <CloseButton onClick={handleClose} />
                </div>
              </header>

              <div className={styles.body}>
                <div className={styles.sidebar} data-expanded={studio.dreamPanelOpen || undefined}>
                  <IconRail
                    activeTab={studio.activeTab}
                    expanded={studio.dreamPanelOpen}
                    onToggle={studio.toggleDreamPanel}
                    onScrollToSection={scrollToSection}
                    onOpenHealth={openPackageHealth}
                    getSectionStatus={studio.getSectionStatus}
                    kind={kind}
                  />
                  {studio.dreamPanelOpen && (
                    <DreamSidePanel
                      session={studio.session}
                      generating={studio.generating}
                      onUpdateSession={studio.updateSessionField}
                      onDream={studio.generateSoul}
                    />
                  )}
                </div>

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

                  <div className={styles.canvas} ref={canvasRef}>
                    {studio.finalizing ? (
                      <WeavingOverlay
                        operation="finalize"
                        currentStepIndex={studio.progress?.operation === 'finalize' ? studio.progress.stepIndex : -1}
                      />
                    ) : showWeavingCanvas ? (
                      <WeavingOverlay
                        operation="soul"
                        currentStepIndex={studio.progress?.operation === 'soul' ? studio.progress.stepIndex : -1}
                      />
                    ) : studio.generatingWorld ? (
                      <WeavingOverlay
                        operation="world"
                        currentStepIndex={studio.progress?.operation === 'world' ? studio.progress.stepIndex : -1}
                      />
                    ) : (
                      <>
                        {studio.activeTab === 'soul' && (
                          <SoulTab
                            draft={studio.draft}
                            extending={studio.extending}
                            onUpdateCard={studio.updateDraftCard}
                            onUpdateAlternates={(value) => studio.updateDraftField('alternate_fields', value)}
                            onUpdateGreetings={(value) => studio.updateDraftField('greetings', value)}
                            onUpdateVoice={(voice) => studio.updateDraftField('voice_guidance', voice)}
                            onExtend={studio.extendField}
                            getSectionStatus={studio.getSectionStatus}
                          />
                        )}
                        {studio.activeTab === 'world' && (
                          <WorldTab
                            draft={studio.draft}
                            generatingWorld={studio.generatingWorld}
                            extending={studio.extending}
                            worldStale={isWorldStale(studio.session)}
                            characterId={studio.session?.character_id ?? null}
                            syncingWorld={studio.syncingWorld}
                            worldSynced={studio.worldSynced}
                            onSyncWorld={studio.syncWorld}
                            onUpdateLorebooks={(value) => studio.updateDraftField('lorebooks', value)}
                            onUpdateNpcs={(value) => studio.updateDraftField('npc_definitions', value)}
                            onUpdateRegexScripts={(value) => studio.updateDraftField('regex_scripts', value)}
                            onGenerateWorld={studio.generateWorld}
                            onExtend={studio.extendField}
                            getSectionStatus={studio.getSectionStatus}
                          />
                        )}
                        {studio.activeTab === 'visuals' && (
                          <VisualsTab
                            draft={studio.draft}
                            worldStale={isWorldStale(studio.session)}
                            visuals={visuals}
                          />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>

              <footer className={styles.footer}>
                <div className={styles.footerLeft}>
                  <span className={styles.sessionName}>
                    {studio.draft?.card?.name || studio.session?.dream_text?.slice(0, 40) || 'Untitled'}
                  </span>
                  <span className={styles.saveStatus} data-dirty={studio.dirty || undefined}>
                    {studio.saving ? 'Saving...' : studio.dirty ? 'Unsaved changes' : 'Saved'}
                  </span>
                </div>
                <div className={styles.footerRight}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClose}
                    disabled={studio.saving || studio.finalizing}
                  >
                    Close
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={showOpenChat ? studio.openChat : studio.finalize}
                    loading={studio.finalizing}
                    disabled={
                      showOpenChat
                        ? studio.finalizing
                        : !canFinalize(studio.session, studio.draft) || studio.finalizing
                    }
                  >
                    {showOpenChat ? 'Open Chat' : 'Finalize'}
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

      {confirmClose && (
        <ConfirmationModal
          isOpen
          title="Unsaved Changes"
          message="You have unsaved changes. Save before closing?"
          variant="warning"
          confirmText="Save & Close"
          cancelText="Keep Editing"
          secondaryText="Discard"
          secondaryVariant="danger"
          onConfirm={handleConfirmClose}
          onSecondary={() => {
            setConfirmClose(false)
            closeModal()
          }}
          onCancel={() => setConfirmClose(false)}
          zIndex={10002}
        />
      )}
    </>,
    document.body,
  )
}
