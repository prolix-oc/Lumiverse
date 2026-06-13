import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { useStore } from '@/store'
import type { WeaverBuildType, WeaverSession } from '@/api/weaver'
import { getCharacterAvatarUrlById } from '@/lib/avatarUrls'
import { BUILD_TYPE_ICONS, Btn, Icon, IconBtn, KindChip, Placeholder, StageTicks, Tile, stageIndexOf, timeAgo } from './primitives'
import { ImportPane } from './ImportPane'
import { TuningPane } from './TuningPane'
import { isEmptyDraft, sessionDisplay, shortDate } from './sessionDisplay'
import styles from './WeaverStudio.module.css'
import s from './StudioHome.module.css'

function NewMenu({ buildTypes, creating, onChoose, onClose }: {
  buildTypes: WeaverBuildType[]
  creating: boolean
  onChoose: (typeId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('weaver')
  const ref = useRef<HTMLDivElement>(null)

  const rows = useMemo(
    () => buildTypes.map((type) => ({
      type,
      title: t(`new.types.${type.id}.title`, { defaultValue: type.id }),
      desc: t(`new.types.${type.id}.desc`, { defaultValue: '' }),
    })),
    [buildTypes, t],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      const hit = rows.find((r) => r.type.enabled && r.title[0]?.toLowerCase() === e.key.toLowerCase())
      if (hit) { e.preventDefault(); onChoose(hit.type.id) }
    }
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [rows, onChoose, onClose])

  return (
    <div ref={ref} className={s.menu} role="menu" aria-label={t('home.new')}>
      <div className={s.menuHead}>
        <span className={s.menuLabel}>{t('home.new')}</span>
        <span className={s.kbd}>esc</span>
      </div>
      {rows.map(({ type, title, desc }) => (
        <button
          key={type.id}
          type="button"
          role="menuitem"
          className={clsx(s.menuRow, !type.enabled && s.menuRowOff)}
          disabled={!type.enabled || creating}
          onClick={() => onChoose(type.id)}
        >
          <Icon name={creating && type.enabled ? 'refresh' : (BUILD_TYPE_ICONS[type.id] ?? 'sparkles')} size={16} spin={creating && type.enabled} />
          <span className={s.menuRowText}>
            <span className={s.menuRowName}>{title}</span>
            <span className={s.menuRowDesc}>{desc}</span>
          </span>
          {type.enabled
            ? <span className={s.kbd}>{title[0]?.toUpperCase()}</span>
            : <KindChip>{t('new.notYet')}</KindChip>}
        </button>
      ))}
    </div>
  )
}

function LoomRow({ session, onOpen, onDelete }: {
  session: WeaverSession
  onOpen: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('weaver')
  const buildTypes = useStore((st) => st.weaverBuildTypes)
  const characters = useStore((st) => st.characters)
  const d = sessionDisplay(session, buildTypes, characters, t('sessions.untitled'))

  return (
    <div
      className={s.row}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <Tile name={d.title} icon={d.icon} size={40} empty={d.empty} />
      <div className={s.rowMain}>
        <div className={s.rowTitleLine}>
          <span className={clsx(s.rowTitle, d.empty && s.isEmpty)}>{d.title}</span>
          <KindChip>{t(`new.types.${session.build_type}.title`, { defaultValue: session.build_type })}</KindChip>
        </div>
        <span className={clsx(s.rowExcerpt, d.empty && s.isHint)}>
          {d.empty ? t('home.noDream') : d.excerpt}
        </span>
      </div>
      <StageTicks stage={stageIndexOf(session)} word />
      <span className={s.rowTime}>{timeAgo(session.updated_at)}</span>
      <IconBtn icon="trash" size={14} cls={clsx(styles.sq28, s.rowDelete)} title={t('sessions.delete')} onClick={(e) => { e.stopPropagation(); onDelete() }} />
    </div>
  )
}

function ShelfCard({ session, onOpen, onDelete }: {
  session: WeaverSession
  onOpen: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation('weaver')
  const buildTypes = useStore((st) => st.weaverBuildTypes)
  const characters = useStore((st) => st.characters)
  const d = sessionDisplay(session, buildTypes, characters, t('sessions.untitled'))
  const character = session.character_id ? characters.find((c) => c.id === session.character_id) : undefined
  const avatarUrl = character ? getCharacterAvatarUrlById(character.id, character.image_id) : null

  return (
    <div
      className={s.card}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen() } }}
    >
      <div className={s.cardArt}>
        {avatarUrl
          ? <img src={avatarUrl} alt="" loading="lazy" />
          : d.icon
            ? <Icon name={d.icon} size={26} />
            : <span className={s.cardMono}>{d.title.slice(0, 2)}</span>}
      </div>
      <div className={s.cardBody}>
        <span className={s.cardName}>{d.title}</span>
        <span className={s.cardLine}>{d.excerpt || t('home.noDream')}</span>
        <div className={s.cardMeta}>
          <KindChip>{t(`new.types.${session.build_type}.title`, { defaultValue: session.build_type })}</KindChip>
          <IconBtn icon="trash" size={13} cls={clsx(styles.sq22, s.rowDelete)} title={t('sessions.delete')} onClick={(e) => { e.stopPropagation(); onDelete() }} />
          <span className={s.cardDate}>{shortDate(session.updated_at)}</span>
        </div>
      </div>
    </div>
  )
}

export function StudioHome({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('weaver')
  const sessions = useStore((st) => st.weaverSessions)
  const buildTypes = useStore((st) => st.weaverBuildTypes)
  const createSession = useStore((st) => st.createWeaverSession)
  const openSession = useStore((st) => st.openWeaverSession)
  const deleteSession = useStore((st) => st.deleteWeaverSession)
  const chooserIntent = useStore((st) => st.weaverChooserIntent)
  const setChooserIntent = useStore((st) => st.setWeaverChooserIntent)

  const [menuOpen, setMenuOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [doorOpen, setDoorOpen] = useState(false)
  const [tuningOpen, setTuningOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (chooserIntent) {
      setMenuOpen(true)
      setChooserIntent(false)
    }
  }, [chooserIntent, setChooserIntent])

  const reaped = useRef(false)
  useEffect(() => {
    if (reaped.current || sessions.length === 0) return
    reaped.current = true
    for (const sess of sessions) {
      if (isEmptyDraft(sess)) void deleteSession(sess.id)
    }
  }, [sessions, deleteSession])

  const drafts = useMemo(
    () => sessions.filter((x) => x.status !== 'finalized').sort((a, b) => b.updated_at - a.updated_at),
    [sessions],
  )
  const finished = useMemo(
    () => sessions.filter((x) => x.status === 'finalized').sort((a, b) => b.updated_at - a.updated_at),
    [sessions],
  )

  const choose = async (typeId: string) => {
    if (creating) return
    if (buildTypes.find((b) => b.id === typeId)?.door) {
      setMenuOpen(false)
      setDoorOpen(true)
      return
    }
    setCreating(true)
    setError(null)
    try {
      await createSession({ build_type: typeId })
      setMenuOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('new.failed'))
    } finally {
      setCreating(false)
    }
  }

  const removeSession = (sess: WeaverSession) => {
    if (window.confirm(t('sessions.deleteConfirm'))) void deleteSession(sess.id)
  }

  if (doorOpen) {
    return <ImportPane onBack={() => setDoorOpen(false)} onClose={onClose} />
  }

  if (tuningOpen) {
    return (
      <div className={clsx(s.root, styles.surfaceEnter)}>
        <TuningPane onBack={() => setTuningOpen(false)} />
      </div>
    )
  }

  return (
    <div className={clsx(s.root, styles.surfaceEnter)}>
      <header className={styles.hdr}>
        <div className={styles.hdrId}>
          <div className={styles.hdrEyebrow}>{t('title')}</div>
          <div className={styles.hdrTitle}>{t('home.title')}</div>
        </div>
        <Btn
          variant="primary"
          icon="plus"
          className={clsx(menuOpen && s.newAnchor)}
          onClick={() => setMenuOpen((o) => !o)}
        >
          {t('home.new')}
        </Btn>
        <IconBtn icon="settings" size={16} cls={styles.sq32} title={t('tuning.title')} onClick={() => setTuningOpen(true)} />
        <IconBtn icon="x" size={16} cls={styles.sq32} title={t('close')} onClick={onClose} />
      </header>

      <div className={clsx(s.body, menuOpen && s.bodyDimmed)}>
        <div className={s.inner}>
          {error && <p className={styles.errorText}>{error}</p>}

          {sessions.length === 0 ? (
            <Placeholder icon="sparkles">{t('home.empty')}</Placeholder>
          ) : (
            <>
              {drafts.length > 0 && (
                <>
                  <div className={s.sect}>
                    <span className={s.sectLabel}>{t('home.loom')}</span>
                    <span className={s.sectCount}>{drafts.length}</span>
                    <span className={s.sectHint}>{t('home.loomHint')}</span>
                  </div>
                  <div className={s.rows}>
                    {drafts.map((sess) => (
                      <LoomRow
                        key={sess.id}
                        session={sess}
                        onOpen={() => openSession(sess.id)}
                        onDelete={() => removeSession(sess)}
                      />
                    ))}
                  </div>
                </>
              )}

              {finished.length > 0 && (
                <>
                  <div className={clsx(s.sect, s.sectShelf)}>
                    <span className={s.sectLabel}>{t('home.library')}</span>
                    <span className={s.sectCount}>{finished.length}</span>
                    <span className={s.sectHint}>{t('home.libraryHint')}</span>
                  </div>
                  <div className={s.shelf}>
                    {finished.map((sess) => (
                      <ShelfCard
                        key={sess.id}
                        session={sess}
                        onOpen={() => openSession(sess.id)}
                        onDelete={() => removeSession(sess)}
                      />
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>

      {menuOpen && (
        <NewMenu
          buildTypes={buildTypes}
          creating={creating}
          onChoose={(id) => void choose(id)}
          onClose={() => setMenuOpen(false)}
        />
      )}
    </div>
  )
}
