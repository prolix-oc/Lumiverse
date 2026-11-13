import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { getCharacterAvatarThumbUrl } from '@/lib/avatarUrls'
import styles from './GroupChatProgressBar.module.css'
import clsx from 'clsx'

export default function GroupChatProgressBar() {
  const { t } = useTranslation('chat')
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
          const avatarUrl = getCharacterAvatarThumbUrl(char)
          return (
            <div key={id}>
              {i > 0 && <span className={styles.connector} />}
              <div
                className={clsx(
                  styles.dot,
                  isActive && styles.dotActive,
                  hasSpoken && !isActive && styles.dotSpoken
                )}
                title={char?.name || t('characterFallback')}
              >
                {char?.avatar_path || char?.image_id ? (
                  <img
                    src={avatarUrl || undefined}
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
          ? t('groupChat.isSpeaking', {
              name: characters.find((c) => c.id === activeGroupCharacterId)?.name || t('characterFallback'),
              spoken: spokenCount,
              total,
            })
          : t('groupChat.spokenProgress', { spoken: spokenCount, total })}
      </span>
    </div>
  )
}
