import { useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowRight, Plus } from 'lucide-react'
import { useStore } from '@/store'
import type { WeaverSession } from '@/api/weaver'
import { Icon, StageTicks, Tile, stageIndexOf, timeAgo } from '@/components/weaver/primitives'
import { sessionDisplay, shortDate } from '@/components/weaver/sessionDisplay'
import styles from './WeaverPanel.module.css'

function useDisplay(session: WeaverSession) {
  const { t } = useTranslation('weaver')
  const buildTypes = useStore((s) => s.weaverBuildTypes)
  const characters = useStore((s) => s.characters)
  return sessionDisplay(session, buildTypes, characters, t('sessions.untitled'))
}

function ResumeCard({ session, onOpen }: { session: WeaverSession; onOpen: () => void }) {
  const { t } = useTranslation('weaver')
  const d = useDisplay(session)
  const stage = stageIndexOf(session)
  return (
    <button type="button" className={styles.resume} onClick={onOpen}>
      <span className={styles.resumeTop}>
        <Tile name={d.title} icon={d.icon} size={40} empty={d.empty} />
        <span className={styles.resumeId}>
          <span className={styles.resumeTitle}>{d.title}</span>
          <span className={styles.resumeMeta}>
            {t(`new.types.${session.build_type}.title`, { defaultValue: session.build_type })}
            <span className={styles.dotSep}>·</span>
            <span className={styles.resumeStage}>
              {stage >= 6 ? t('stages.finalize') : t(`stages.${session.stage}`)}
            </span>
            <span className={styles.dotSep}>·</span>
            {timeAgo(session.updated_at)}
          </span>
        </span>
        <ArrowRight size={15} className={styles.resumeArrow} />
      </span>
      <span className={styles.resumeTicks}>
        <StageTicks stage={stage} stretch />
      </span>
    </button>
  )
}

function SessionRow({ session, onOpen, trailing }: {
  session: WeaverSession
  onOpen: () => void
  trailing: React.ReactNode
}) {
  const d = useDisplay(session)
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      <Tile name={d.title} icon={d.icon} size={24} empty={d.empty} />
      <span className={styles.rowTitle}>{d.title}</span>
      {trailing}
    </button>
  )
}

export default function WeaverPanel() {
  const { t } = useTranslation('weaver')
  const openModal = useStore((s) => s.openModal)

  const sessions = useStore((s) => s.weaverSessions)
  const loadSessions = useStore((s) => s.loadWeaverSessions)
  const loadBuildTypes = useStore((s) => s.loadWeaverBuildTypes)
  const openSession = useStore((s) => s.openWeaverSession)
  const setChooserIntent = useStore((s) => s.setWeaverChooserIntent)

  useEffect(() => {
    void loadSessions()
    void loadBuildTypes()
  }, [loadSessions, loadBuildTypes])

  const drafts = useMemo(
    () => sessions.filter((x) => x.status !== 'finalized').sort((a, b) => b.updated_at - a.updated_at),
    [sessions],
  )
  const finished = useMemo(
    () => sessions.filter((x) => x.status === 'finalized').sort((a, b) => b.updated_at - a.updated_at),
    [sessions],
  )
  const resume = drafts[0] ?? null
  const loomRest = drafts.slice(1)

  const openHome = () => {
    openSession(null)
    openModal('weaver')
  }
  const openNew = () => {
    setChooserIntent(true)
    openHome()
  }
  const open = (id: string) => {
    openSession(id)
    openModal('weaver')
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <span className={styles.eyebrow}>{t('title')}</span>
      </div>

      {sessions.length === 0 && <p className={styles.blurb}>{t('panel.blurb')}</p>}

      {resume && (
        <div className={styles.block}>
          <span className={styles.sectLabel}>{t('panel.pickUp')}</span>
          <ResumeCard session={resume} onOpen={() => open(resume.id)} />
        </div>
      )}

      <div className={styles.actions}>
        <button type="button" className={styles.openStudio} onClick={openHome}>
          {t('panel.openStudio')}
          <ArrowRight size={15} />
        </button>
        <button type="button" className={styles.newBtn} onClick={openNew}>
          <Plus size={13} />
          {t('home.new')}
        </button>
      </div>

      {loomRest.length > 0 && (
        <div className={styles.block}>
          <div className={styles.sectRow}>
            <span className={styles.sectLabel}>{t('home.loom')}</span>
            <span className={styles.sectCount}>{drafts.length}</span>
          </div>
          <div className={styles.list}>
            {loomRest.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onOpen={() => open(s.id)}
                trailing={<span className={styles.rowTicks}><StageTicks stage={stageIndexOf(s)} compact /></span>}
              />
            ))}
          </div>
        </div>
      )}

      {finished.length > 0 && (
        <div className={styles.block}>
          <div className={styles.sectRow}>
            <span className={styles.sectLabel}>{t('home.library')}</span>
            <span className={styles.sectCount}>{finished.length}</span>
          </div>
          <div className={styles.list}>
            {finished.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                onOpen={() => open(s.id)}
                trailing={<span className={styles.rowDate}>{shortDate(s.updated_at)}</span>}
              />
            ))}
          </div>
        </div>
      )}

      {sessions.length === 0 && (
        <div className={styles.emptyHint}>
          <Icon name="sparkles" size={18} />
          <span>{t('home.empty')}</span>
        </div>
      )}
    </div>
  )
}
