import { useState } from 'react'
import { BookOpen, Globe, User, UserRound } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import clsx from 'clsx'
import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import { getCharacterWorldBookIds, setCharacterWorldBookIds } from '@/utils/character-world-books'
import { personasApi } from '@/api/personas'
import type { WorldBook } from '@/types/api'
import styles from './PostImportWorldBookModal.module.css'

interface Props {
  book: WorldBook
  onClose: () => void
}

export default function PostImportWorldBookModal({ book, onClose }: Props) {
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activePersonaId = useStore((s) => s.activePersonaId)
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

  const finish = (message: string) => {
    addToast({ type: 'success', message })
    onClose()
  }

  const attachToCharacter = async () => {
    if (!activeCharacterId || !activeCharacter) return
    setBusy('character')
    setError(null)
    try {
      const currentIds = getCharacterWorldBookIds(activeCharacter.extensions)
      const nextIds = Array.from(new Set([...currentIds, book.id]))
      const updated = await charactersApi.update(activeCharacterId, {
        extensions: setCharacterWorldBookIds(
          { ...(activeCharacter.extensions || {}) },
          nextIds,
        ),
      })
      updateCharacter(activeCharacterId, updated)
      finish(`Attached "${book.name}" to ${updated.name}.`)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to attach book to the current character')
    } finally {
      setBusy(null)
    }
  }

  const attachToPersona = async () => {
    if (!activePersonaId) return
    setBusy('persona')
    setError(null)
    try {
      const updated = await personasApi.update(activePersonaId, {
        attached_world_book_id: book.id,
      })
      updatePersona(activePersonaId, updated)
      finish(`Attached "${book.name}" to ${updated.name}.`)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to attach book to the active persona')
    } finally {
      setBusy(null)
    }
  }

  const addToGlobalBooks = () => {
    setBusy('global')
    setError(null)
    try {
      const next = Array.from(new Set([...(globalWorldBooks ?? []), book.id]))
      setSetting('globalWorldBooks', next)
      finish(`Added "${book.name}" to global world books.`)
    } catch (err: any) {
      setError(err?.message || 'Failed to add book to global world books')
      setBusy(null)
    }
  }

  return (
    <ModalShell isOpen onClose={onClose} maxWidth={700} zIndex={10002} className={styles.modal}>
      <div className={styles.header}>
        <div>
          <div className={styles.eyebrow}>Import Complete</div>
          <h2 className={styles.title}>Choose where "{book.name}" should be active</h2>
        </div>
        <CloseButton onClick={onClose} />
      </div>

      <div className={styles.intro}>
        <p className={styles.copy}>
          Standalone imports stay unattached until you pick a target.
        </p>
        <p className={styles.copySubtle}>
          You can attach this lorebook to a character, tie it to the active persona, or make it globally available.
        </p>
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
              {activeCharacter
                ? recommendedTarget === 'character' ? 'Recommended' : 'Available'
                : 'Unavailable'}
            </span>
          </div>
          <span className={styles.actionEyebrow}>Current character</span>
          <span className={styles.actionTitle}>{activeCharacter ? activeCharacter.name : 'No active character'}</span>
          <span className={styles.actionMeta}>
            {activeCharacter
              ? 'Attach this lorebook to the character you are currently chatting with.'
              : 'Open a character chat first, then attach the lorebook here.'}
          </span>
          <span className={styles.actionHint}>{busy === 'character' ? 'Attaching...' : 'Attach now'}</span>
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
              {activePersona
                ? recommendedTarget === 'persona' ? 'Recommended' : 'Available'
                : 'Unavailable'}
            </span>
          </div>
          <span className={styles.actionEyebrow}>Active persona</span>
          <span className={styles.actionTitle}>{activePersona ? activePersona.name : 'No active persona'}</span>
          <span className={styles.actionMeta}>
            {activePersona
              ? 'Use this lorebook whenever this persona is active.'
              : 'Set an active persona first if you want the lorebook to follow that persona.'}
          </span>
          <span className={styles.actionHint}>{busy === 'persona' ? 'Attaching...' : 'Attach now'}</span>
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
              {recommendedTarget === 'global' ? 'Recommended' : 'Available'}
            </span>
          </div>
          <span className={styles.actionEyebrow}>Global books</span>
          <span className={styles.actionTitle}>Always active</span>
          <span className={styles.actionMeta}>
            Make this lorebook available in every chat until you remove it from global books.
          </span>
          <span className={styles.actionHint}>{busy === 'global' ? 'Saving...' : 'Add globally'}</span>
        </button>
      </div>

      <div className={styles.footer}>
        <div className={styles.footerHint}>
          <BookOpen size={13} />
          <span>You can still attach it later from the character, persona, or world-book panel.</span>
        </div>
        <button type="button" className={styles.skipBtn} onClick={onClose}>
          Skip for now
        </button>
      </div>
    </ModalShell>
  )
}
