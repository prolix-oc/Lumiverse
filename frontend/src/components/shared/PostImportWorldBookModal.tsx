import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Globe, User, UserRound } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import clsx from 'clsx'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from '@/utils/character-world-books'
import { personasApi } from '@/api/personas'
import { filterWorldBooksForChatContextAttachment } from '@/lib/worldBookIndexPrompt'
import type { WorldBook } from '@/types/api'
import styles from './PostImportWorldBookModal.module.css'

interface Props {
  book: WorldBook
  onClose: () => void
}

export default function PostImportWorldBookModal({ book, onClose }: Props) {
  const { t } = useTranslation('modals', { keyPrefix: 'postImportWorldBook' })

  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const activeChatId = useStore((s) => s.activeChatId)
  const characters = useStore((s) => s.characters)
  const personas = useStore((s) => s.personas)
  const globalWorldBooks = useStore((s) => s.globalWorldBooks)
  const setSetting = useStore((s) => s.setSetting)
  const updateCharacter = useStore((s) => s.updateCharacter)
  const updatePersona = useStore((s) => s.updatePersona)
  const addToast = useStore((s) => s.addToast)

  const [busy, setBusy] = useState<'character' | 'persona' | 'global' | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeCharacter = characters.find((character) => character.id === activeCharacterId) || null
  const activePersona = personas.find((persona) => persona.id === activePersonaId) || null
  const recommendedTarget = activeCharacter ? 'character' : activePersona ? 'persona' : 'global'

  const badgeLabel = (target: 'character' | 'persona' | 'global', available: boolean) => {
    if (!available) return t('badgeUnavailable')
    return recommendedTarget === target ? t('badgeRecommended') : t('badgeAvailable')
  }

  const finish = (message: string) => {
    addToast({ type: 'success', message })
    onClose()
  }

  const attachToCharacter = async () => {
    if (!activeCharacterId || !activeCharacter) return
    setBusy('character')
    setError(null)
    try {
      if (activeChatId) {
        const approvedIds = await filterWorldBooksForChatContextAttachment([book])
        if (approvedIds.length === 0) return
      }
      const currentIds = getCharacterWorldBookIds(activeCharacter.extensions)
      const nextIds = Array.from(new Set([...currentIds, book.id]))
      const updated = await charactersApi.update(activeCharacterId, {
        extensions: setCharacterWorldBookIds(
          { ...(activeCharacter.extensions || {}) },
          nextIds,
        ),
      })
      updateCharacter(activeCharacterId, updated)
      finish(t('toastAttachedCharacter', { book: book.name, target: updated.name }))
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('errorAttachCharacter'))
    } finally {
      setBusy(null)
    }
  }

  const attachToPersona = async () => {
    if (!activePersonaId) return
    setBusy('persona')
    setError(null)
    try {
      if (activeChatId) {
        const approvedIds = await filterWorldBooksForChatContextAttachment([book])
        if (approvedIds.length === 0) return
      }
      const updated = await personasApi.update(activePersonaId, {
        attached_world_book_id: book.id,
      })
      updatePersona(activePersonaId, updated)
      finish(t('toastAttachedPersona', { book: book.name, target: updated.name }))
    } catch (err: any) {
      setError(err?.body?.error || err?.message || t('errorAttachPersona'))
    } finally {
      setBusy(null)
    }
  }

  const addToGlobalBooks = async () => {
    setBusy('global')
    setError(null)
    try {
      if (activeChatId) {
        const approvedIds = await filterWorldBooksForChatContextAttachment([book])
        if (approvedIds.length === 0) return
      }
      const next = Array.from(new Set([...(globalWorldBooks ?? []), book.id]))
      setSetting('globalWorldBooks', next)
      finish(t('toastAddedGlobal', { book: book.name }))
    } catch (err: any) {
      setError(err?.message || t('errorAddGlobal'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={700} zIndex={10002} className={styles.modal}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>{t('eyebrow')}</div>
          <h2 className={styles.title}>{t('title', { name: book.name })}</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className={styles.body}>
        <div className={styles.intro}>
          <p className={styles.copy}>{t('intro')}</p>
          <p className={styles.copySubtle}>{t('introSubtle')}</p>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button
            type="button"
            className={clsx(
              styles.actionCard,
              recommendedTarget === 'character' && activeCharacter && styles.actionCardRecommended,
            )}
            onClick={attachToCharacter}
            disabled={!activeCharacter || busy !== null}
          >
            <div className={styles.actionTopRow}>
              <span className={styles.actionIcon}><User size={15} /></span>
              <span className={clsx(styles.actionBadge, !activeCharacter && styles.actionBadgeMuted)}>
                {badgeLabel('character', !!activeCharacter)}
              </span>
            </div>
            <span className={styles.actionEyebrow}>{t('characterEyebrow')}</span>
            <span className={styles.actionTitle}>
              {activeCharacter ? activeCharacter.name : t('noActiveCharacter')}
            </span>
            <span className={styles.actionMeta}>
              {activeCharacter ? t('characterMetaActive') : t('characterMetaInactive')}
            </span>
            <span className={styles.actionHint}>
              {busy === 'character' ? t('attaching') : t('attachNow')}
            </span>
          </button>

          <button
            type="button"
            className={clsx(
              styles.actionCard,
              recommendedTarget === 'persona' && activePersona && styles.actionCardRecommended,
            )}
            onClick={attachToPersona}
            disabled={!activePersona || busy !== null}
          >
            <div className={styles.actionTopRow}>
              <span className={styles.actionIcon}><UserRound size={15} /></span>
              <span className={clsx(styles.actionBadge, !activePersona && styles.actionBadgeMuted)}>
                {badgeLabel('persona', !!activePersona)}
              </span>
            </div>
            <span className={styles.actionEyebrow}>{t('personaEyebrow')}</span>
            <span className={styles.actionTitle}>
              {activePersona ? activePersona.name : t('noActivePersona')}
            </span>
            <span className={styles.actionMeta}>
              {activePersona ? t('personaMetaActive') : t('personaMetaInactive')}
            </span>
            <span className={styles.actionHint}>
              {busy === 'persona' ? t('attaching') : t('attachNow')}
            </span>
          </button>

          <button
            type="button"
            className={clsx(
              styles.actionCard,
              recommendedTarget === 'global' && styles.actionCardRecommended,
            )}
            onClick={addToGlobalBooks}
            disabled={busy !== null}
          >
            <div className={styles.actionTopRow}>
              <span className={styles.actionIcon}><Globe size={15} /></span>
              <span className={styles.actionBadge}>
                {badgeLabel('global', true)}
              </span>
            </div>
            <span className={styles.actionEyebrow}>{t('globalEyebrow')}</span>
            <span className={styles.actionTitle}>{t('globalTitle')}</span>
            <span className={styles.actionMeta}>{t('globalMeta')}</span>
            <span className={styles.actionHint}>
              {busy === 'global' ? t('saving') : t('addGlobally')}
            </span>
          </button>
        </div>
      </div>

      <div className={styles.footer}>
        <div className={styles.footerHint}>
          <BookOpen size={13} />
          <span>{t('footerHint')}</span>
        </div>
        <button type="button" className={styles.skipBtn} onClick={onClose}>
          {t('skipForNow')}
        </button>
      </div>
    </ModalShell>
  )
}
