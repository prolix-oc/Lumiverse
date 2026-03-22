import clsx from 'clsx'
import styles from './OOCStyles.module.css'

interface OOCWhisperBubbleProps {
  content: string
  avatarUrl: string | null
  displayName: string
  isAlt?: boolean
}

export default function OOCWhisperBubble({ content, avatarUrl, displayName, isAlt }: OOCWhisperBubbleProps) {
  return (
    <div className={clsx(styles.whisper, isAlt && styles.whisperAlt)}>
      <div className={styles.whisperAvatarWrap}>
        {avatarUrl ? (
          <img className={styles.whisperAvatar} src={avatarUrl} alt={displayName} />
        ) : (
          <div className={styles.whisperAvatarPlaceholder}>
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div className={styles.whisperBubble}>
        <div className={styles.whisperHeader}>
          <span className={styles.whisperName}>{displayName} whispers...</span>
        </div>
        <div
          className={styles.whisperText}
          dangerouslySetInnerHTML={{ __html: content }}
        />
      </div>
    </div>
  )
}
