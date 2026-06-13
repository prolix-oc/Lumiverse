import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { WeaverSession, WeaverStage } from '@/api/weaver'
import type { Character } from '@/types/api'
import { charactersApi } from '@/api/characters'
import { IconBtn, KindChip, STAGES, Tile } from './primitives'
import { sessionDisplay } from './sessionDisplay'
import { StudioHome } from './StudioHome'
import { DreamStage } from './stages/DreamStage'
import { ReadbackStage } from './stages/ReadbackStage'
import { InterviewStage } from './stages/InterviewStage'
import { BibleStage } from './stages/BibleStage'
import { RenderStage } from './stages/RenderStage'
import { FinalizeStage } from './stages/FinalizeStage'
import { DashboardHeader, DashboardView } from './dashboard/DashboardView'
import styles from './WeaverStudio.module.css'

const REACHABLE: WeaverStage[] = ['dream', 'readback', 'interview', 'bible', 'render', 'finalize']

export function WeaverStudio() {
  const { t } = useTranslation('weaver')
  const activeModal = useStore((s) => s.activeModal)
  const closeModal = useStore((s) => s.closeModal)

  const sessions = useStore((s) => s.weaverSessions)
  const activeId = useStore((s) => s.activeWeaverSessionId)
  const loadSessions = useStore((s) => s.loadWeaverSessions)
  const loadSlots = useStore((s) => s.loadWeaverSlots)
  const loadBuildTypes = useStore((s) => s.loadWeaverBuildTypes)

  const open = activeModal === 'weaver'
  const active = useMemo<WeaverSession | null>(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  )

  useEffect(() => {
    if (open) {
      void loadSessions()
      void loadBuildTypes()
    }
  }, [open, loadSessions, loadBuildTypes])

  useEffect(() => {
    if (open && active) void loadSlots(active.build_type)
  }, [open, active, loadSlots])

  if (!open) return null

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label={t('title')}>
      <div className={styles.shell}>
        {active ? (
          <SessionWorkspace key={active.id} session={active} onClose={closeModal} />
        ) : (
          <StudioHome onClose={closeModal} />
        )}
      </div>
    </div>
  )
}

function useStartWeaverChat(sessionId: string) {
  const startChat = useStore((s) => s.startWeaverChat)
  const setActiveChat = useStore((s) => s.setActiveChat)
  const closeModal = useStore((s) => s.closeModal)
  const starting = useStore((s) => s.weaverStartingChat)
  const run = useCallback(async () => {
    try {
      const r = await startChat(sessionId)
      setActiveChat(r.chat.id, r.chat.character_id)
      closeModal()
    } catch {
    }
  }, [sessionId, startChat, setActiveChat, closeModal])
  return { run, starting }
}

function SessionWorkspace({ session, onClose }: { session: WeaverSession; onClose: () => void }) {
  const { t } = useTranslation('weaver')
  const isFinalized = session.status === 'finalized'
  const [viewMode, setViewMode] = useState<'pipeline' | 'dashboard'>(isFinalized ? 'dashboard' : 'pipeline')
  const [viewStage, setViewStage] = useState<WeaverStage>(
    REACHABLE.includes(session.stage) ? session.stage : 'dream',
  )

  const finalizeResult = useStore((s) => (s.weaverStateSessionId === session.id ? s.weaverFinalizeResult : null))
  const [character, setCharacter] = useState<Character | null>(finalizeResult?.character ?? null)

  useEffect(() => {
    setViewMode(isFinalized ? 'dashboard' : 'pipeline')
    setViewStage(REACHABLE.includes(session.stage) ? session.stage : 'dream')
  }, [session.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isFinalized) return
    if (finalizeResult?.character) { setCharacter(finalizeResult.character); return }
    if (!session.character_id) return
    let alive = true
    void charactersApi.get(session.character_id).then((c) => { if (alive) setCharacter(c) }).catch(() => {})
    return () => { alive = false }
  }, [isFinalized, session.character_id, finalizeResult])

  const { run: startChat, starting } = useStartWeaverChat(session.id)
  const onExport = useCallback(() => {
    if (character) void charactersApi.exportCharacter(character.id, 'png', character.name)
  }, [character])

  const reachedIndex = STAGES.indexOf(session.stage)

  const goToStage = (stage: WeaverStage) => {
    const idx = STAGES.indexOf(stage)
    if (idx <= reachedIndex && REACHABLE.includes(stage)) setViewStage(stage)
  }

  const inDashboard = viewMode === 'dashboard' && isFinalized

  if (inDashboard) {
    return (
      <>
        <DashboardHeader
          character={character}
          buildType={session.build_type}
          starting={starting}
          onBuild={() => setViewMode('pipeline')}
          onExport={onExport}
          onStartChat={() => void startChat()}
          onClose={onClose}
        />
        <DashboardView
          session={session}
          character={character}
          starting={starting}
          onBuild={() => setViewMode('pipeline')}
          onStartChat={() => void startChat()}
          onCharacterUpdate={setCharacter}
        />
      </>
    )
  }

  return (
    <>
      <PipelineHeader session={session} onClose={onClose} />
      <nav className={styles.track} aria-label="stages">
        {STAGES.map((stage, index) => {
          const isReachable = REACHABLE.includes(stage) && index <= reachedIndex
          const isCurrent = stage === viewStage
          return (
            <Fragment key={stage}>
              {index > 0 && <span className={styles.trackSep} aria-hidden="true">›</span>}
              <button
                type="button"
                className={clsx(styles.trackStep, isCurrent ? styles.trackActive : isReachable ? styles.trackReachable : styles.trackLocked)}
                disabled={!isReachable && !isCurrent}
                onClick={() => goToStage(stage)}
                title={isReachable || isCurrent ? undefined : t('stages.comingSoon')}
              >
                {t(`stages.${stage}`)}
              </button>
            </Fragment>
          )
        })}
      </nav>

      <div key={viewStage} className={styles.stageSwap}>
        {viewStage === 'dream' && (
          <DreamStage session={session} onAdvance={() => setViewStage('readback')} />
        )}
        {viewStage === 'readback' && (
          <ReadbackStage session={session} onBack={() => setViewStage('dream')} onContinue={() => setViewStage('interview')} />
        )}
        {viewStage === 'interview' && (
          <InterviewStage session={session} onBack={() => setViewStage('readback')} onContinue={() => setViewStage('bible')} />
        )}
        {viewStage === 'bible' && (
          <BibleStage session={session} onBack={() => setViewStage('interview')} onContinue={() => setViewStage('render')} />
        )}
        {viewStage === 'render' && (
          <RenderStage session={session} onBack={() => setViewStage('bible')} onContinue={() => setViewStage('finalize')} />
        )}
        {viewStage === 'finalize' && (
          <FinalizeStage session={session} onBack={() => setViewStage('render')} onOpenStudio={() => setViewMode('dashboard')} />
        )}
      </div>
    </>
  )
}

function PipelineHeader({ session, onClose }: { session: WeaverSession; onClose: () => void }) {
  const { t } = useTranslation('weaver')
  const openSession = useStore((s) => s.openWeaverSession)
  const buildTypes = useStore((s) => s.weaverBuildTypes)
  const characters = useStore((s) => s.characters)
  const d = sessionDisplay(session, buildTypes, characters, t('sessions.untitled'))
  return (
    <header className={styles.hdr}>
      <Tile name={d.title} icon={d.icon} size={32} empty={d.empty} />
      <div className={styles.hdrId}>
        <div className={styles.hdrEyebrow}>{t('title')}</div>
        <div className={styles.hdrNameRow}>
          <span className={styles.hdrTitle} title={d.title}>{d.title}</span>
          <KindChip>{t(`new.types.${session.build_type}.title`, { defaultValue: session.build_type })}</KindChip>
        </div>
      </div>
      <IconBtn icon="home" size={16} cls={styles.sq32} title={t('home.backTitle')} onClick={() => openSession(null)} />
      <span className={styles.headSep} />
      <IconBtn icon="x" size={16} cls={styles.sq32} title={t('close')} onClick={onClose} />
    </header>
  )
}
