import { useStore } from '@/store'
import { charactersApi } from '@/api/characters'
import styles from './GroupChatProgressBar.module.css'
import clsx from 'clsx'

export default function GroupChatProgressBar() {
  const groupCharacterIds = useStore((s) => s.groupCharacterIds)
  const characters = useStore((s) => s.characters)
  const activeGroupCharacterId = useStore((s) => s.activeGroupCharacterId)
  const roundCharactersSpoken = useStore((s) => s.roundCharactersSpoken)
  const roundTotal = useStore((s) => s.roundTotal)

  const spokenCount = roundCharactersSpoken.length + (activeGroupCharacterId ? 1 : 0)
  const total = roundTotal || groupCharacterIds.length

  return (
    <div className={styles.bar}>
      <div className={styles.characterDots}>
        {groupCharacterIds.map((id, i) => {
          const char = characters.find((c) => c.id === id)
          const isActive = id === activeGroupCharacterId
          const hasSpoken = roundCharactersSpoken.includes(id)
          return (
            <div key={id}>
              {i > 0 && <span className={styles.connector} />}
              <div
                className={clsx(
                  styles.dot,
                  isActive && styles.dotActive,
                  hasSpoken && !isActive && styles.dotSpoken
                )}
                title={char?.name || 'Character'}
              >
                {char?.avatar_path || char?.image_id ? (
                  <img
                    src={charactersApi.avatarUrl(id)}
                    alt={char?.name}
                    className={styles.dotAvatar}
                  />
                ) : (
                  <span className={styles.dotAvatarFallback}>
                    {char?.name?.[0]?.toUpperCase() || '?'}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <span className={styles.status}>
        {activeGroupCharacterId
          ? `${characters.find((c) => c.id === activeGroupCharacterId)?.name || 'Character'} is speaking... (${spokenCount}/${total})`
          : `${spokenCount}/${total} spoken`}
      </span>
    </div>
  )
}
