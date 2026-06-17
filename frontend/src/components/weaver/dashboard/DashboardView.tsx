import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import * as weaverApi from '@/api/weaver'
import type { WeaverSession } from '@/api/weaver'
import type { Character } from '@/types/api'
import { getCharacterAvatarUrlById } from '@/lib/avatarUrls'
import { Btn, Icon, IconBtn, Placeholder, SDot, Tile } from '../primitives'
import { PortraitPane } from '../PortraitPane'
import { ExpressionsPane } from '../ExpressionsPane'
import { OverviewPane } from './OverviewPane'
import { WorldHubPane } from './WorldHubPane'
import { PeoplePane } from './PeoplePane'
import styles from '../WeaverStudio.module.css'

interface DashboardChromeProps {
  character: Character | null
  buildType: string
  starting: boolean
  onBuild: () => void
  onExport: () => void
  onStartChat: () => void
  onClose: () => void
}
export function DashboardHeader({ character, buildType, starting, onBuild, onExport, onStartChat, onClose }: DashboardChromeProps) {
  const { t } = useTranslation('weaver')
  const openSession = useStore((s) => s.openWeaverSession)
  const name = character?.name ?? t('finalize.untitled')
  const avatarUrl = character ? getCharacterAvatarUrlById(character.id, character.image_id) : null
  const tags = character?.tags ?? []
  return (
    <header className={styles.hdr}>
      {avatarUrl
        ? <div className={styles.hdrAvatar}><img src={avatarUrl} alt={name} /></div>
        : <Tile name={name} size={32} />}
      <div className={styles.hdrId}>
        <div className={styles.dashEyebrow}>{t(`dashboard.eyebrowType.${buildType}`, { defaultValue: t('dashboard.eyebrow') })}</div>
        <div className={styles.hdrNameRow}>
          <span className={styles.hdrName}>{name}</span>
          {tags.slice(0, 2).map((tg) => <span key={tg} className={styles.inlineChip}>{tg}</span>)}
          <span className={styles.statusChip}><span className={styles.liveDot} /> {t('dashboard.finalizedChip')}</span>
        </div>
      </div>
      <div className={styles.hdrActions}>
        <Btn icon="build" onClick={onBuild} title={t('dashboard.buildTitle')}>{t('dashboard.build')}</Btn>
        <Btn icon="download" disabled={!character} onClick={onExport} title={t('dashboard.exportTitle')}>{t('dashboard.export')}</Btn>
        <Btn variant="primary" icon={starting ? 'refresh' : 'chat'} spin={starting} disabled={starting || !character} onClick={onStartChat}>{t('dashboard.startChat')}</Btn>
        <span className={styles.headSep} />
        <IconBtn icon="home" size={16} cls={styles.sq32} title={t('home.backTitle')} onClick={() => openSession(null)} />
        <IconBtn icon="x" size={16} cls={styles.sq32} title={t('close')} onClick={onClose} />
      </div>
    </header>
  )
}

const DASH_RAIL = [
  { id: 'overview', icon: 'layers', group: 'card' },
  { id: 'portrait', icon: 'user', group: 'img' },
  { id: 'expressions', icon: 'smile', group: 'img' },
  { id: 'scenes', icon: 'image', group: 'img' },
  { id: 'alternates', icon: 'copy', group: 'img' },
] as const
type DashKind = (typeof DASH_RAIL)[number]['id']
type PaneKind = DashKind | 'hub' | 'people'

const VISUAL_PANE_ICON: Record<string, string> = { portrait: 'user', expressions: 'smile', scenes: 'image', alternates: 'copy' }
function VisualPane({ kind }: { kind: Exclude<DashKind, 'overview'> }) {
  const { t } = useTranslation('weaver')
  return (
    <div className={styles.visualPane}>
      <div className={styles.visualHead}>
        <h2 className={styles.visualTitle}>{t(`dashboard.rail.${kind}`)}</h2>
        <p className={styles.visualSub}>{t(`dashboard.visual.${kind}Sub`)}</p>
      </div>
      <div className={styles.canvasEmpty}>
        <div className={styles.ceFrame}><Icon name={VISUAL_PANE_ICON[kind]} size={22} /></div>
        <div className={styles.ceTitle}>{t(`dashboard.rail.${kind}`)}</div>
        <div className={styles.ceSub}>{t('dashboard.visual.comingSoon')}</div>
      </div>
    </div>
  )
}

interface DashboardViewProps {
  session: WeaverSession
  character: Character | null
  starting: boolean
  onBuild: () => void
  onStartChat: () => void
  onCharacterUpdate: (character: Character) => void
}

function WorldTieBand({ session }: { session: WeaverSession }) {
  const { t } = useTranslation('weaver')
  const sessions = useStore((s) => s.weaverSessions)
  const characters = useStore((s) => s.characters)
  const openSession = useStore((s) => s.openWeaverSession)

  const worldSessionId = session.seed.provenance.world_session_id
  if (typeof worldSessionId !== 'string' || !worldSessionId) return null
  const worldSession = sessions.find((x) => x.id === worldSessionId)
  if (!worldSession) return null
  const worldName = (worldSession.character_id
    ? characters.find((c) => c.id === worldSession.character_id)?.name
    : null) ?? t('dashboard.tie.world')

  return (
    <div className={styles.tieBand}>
      <Icon name="globe" size={14} />
      {t('dashboard.tie.carries', { world: worldName })}
      <span className={styles.tieBandDim}>{t('dashboard.tie.bound')}</span>
      <span className={styles.tieBandOpen}>
        <Btn iconRight="arrowRight" onClick={() => openSession(worldSessionId)}>
          {t('dashboard.tie.open', { world: worldName })}
        </Btn>
      </span>
    </div>
  )
}

export function DashboardView({ session, character, starting, onBuild, onStartChat, onCharacterUpdate }: DashboardViewProps) {
  const { t } = useTranslation('weaver')
  const buildTypes = useStore((s) => s.weaverBuildTypes)
  const hasHub = buildTypes.find((bt) => bt.id === session.build_type)?.hub === true
  const [kindChoice, setKindChoice] = useState<PaneKind | null>(null)
  const kind: PaneKind = kindChoice ?? (hasHub ? 'hub' : 'overview')
  const setKind = setKindChoice
  const [portraitCount, setPortraitCount] = useState(0)
  const [expressionsCount, setExpressionsCount] = useState(0)
  const [peopleCount, setPeopleCount] = useState<number | null>(null)
  const hasAvatar = Boolean(character && (character.image_id || character.avatar_path))

  useEffect(() => {
    if (!hasHub) return
    weaverApi.getPeople(session.id)
      .then((r) => setPeopleCount(r.people.length))
      .catch(() => {})
  }, [hasHub, session.id])

  const railItems = DASH_RAIL.filter((r) => !(hasHub && r.id === 'expressions'))

  const railTrailing = (id: DashKind) => {
    if (id === 'portrait') return (
      <>
        {portraitCount > 0 && <span className={styles.dashCount}>{portraitCount}</span>}
        <SDot status={hasAvatar ? 'committed' : 'none'} />
      </>
    )
    if (id === 'expressions') return (
      <>
        {expressionsCount > 0 && <span className={styles.dashCount}>{expressionsCount}</span>}
        <SDot status={expressionsCount > 0 ? 'committed' : 'none'} />
      </>
    )
    if (id === 'overview') return null
    return <span className={styles.dashCount}>0</span>
  }

  return (
    <>
      <WorldTieBand session={session} />
      <div className={styles.dashBody}>
        <aside className={styles.dashRail}>
          {hasHub && (
            <>
              <button
                type="button"
                className={clsx(styles.railItem, kind === 'hub' && styles.railItemActive)}
                onClick={() => setKind('hub')}
              >
                <span className={styles.dashRailIcon}><Icon name="globe" size={17} /></span>
                <span className={styles.railName}>{t('dashboard.rail.hub')}</span>
              </button>
              <button
                type="button"
                className={clsx(styles.railItem, kind === 'people' && styles.railItemActive)}
                onClick={() => setKind('people')}
              >
                <span className={styles.dashRailIcon}><Icon name="user" size={17} /></span>
                <span className={styles.railName}>{t('dashboard.rail.people')}</span>
                {peopleCount !== null && peopleCount > 0 && <span className={styles.dashCount}>{peopleCount}</span>}
              </button>
            </>
          )}
          {railItems.map((r) => (
            <Fragment key={r.id}>
              {r.id === 'portrait' && (
                <>
                  <div className={styles.dashRailDivider} />
                  <div className={styles.dashRailSection}>{t('dashboard.rail.imagesGroup')}</div>
                </>
              )}
              <button
                type="button"
                className={clsx(styles.railItem, kind === r.id && styles.railItemActive)}
                onClick={() => setKind(r.id)}
              >
                <span className={styles.dashRailIcon}><Icon name={r.icon} size={17} /></span>
                <span className={styles.railName}>{t(`dashboard.rail.${r.id}`)}</span>
                {railTrailing(r.id)}
              </button>
            </Fragment>
          ))}
        </aside>

        <div className={styles.dashPane} key={kind}>
          {kind === 'hub' ? (
            <WorldHubPane session={session} />
          ) : kind === 'people' ? (
            <PeoplePane session={session} onCount={setPeopleCount} />
          ) : !character ? (
            <div className={styles.dashPaneInner}><Placeholder icon="refresh" spin>{t('dashboard.loadingCard')}</Placeholder></div>
          ) : kind === 'overview' ? (
            <OverviewPane character={character} session={session} onBuild={onBuild} onCharacterUpdate={onCharacterUpdate} />
          ) : kind === 'portrait' ? (
            <PortraitPane sessionId={session.id} character={character} onCharacterUpdate={onCharacterUpdate} onCount={setPortraitCount} />
          ) : kind === 'expressions' ? (
            <ExpressionsPane sessionId={session.id} character={character} onCount={setExpressionsCount} />
          ) : (
            <VisualPane kind={kind} />
          )}
        </div>
      </div>

      {kind !== 'portrait' && kind !== 'expressions' && (
        <div className={styles.footer}>
          <div className={styles.ftrContext}>
            <Icon name="check" size={14} />
            <span>{t('dashboard.readyContext')}</span>
          </div>
          <div className={styles.spacer} />
          <Btn variant="primary" icon={starting ? 'refresh' : 'chat'} spin={starting} disabled={starting || !character} onClick={onStartChat}>
            {t('dashboard.startChat')}
          </Btn>
        </div>
      )}
    </>
  )
}
