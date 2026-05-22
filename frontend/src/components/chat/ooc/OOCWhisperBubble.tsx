import { useMemo } from 'react'
import clsx from 'clsx'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import styles from './OOCStyles.module.css'

interface OOCWhisperBubbleProps {
  content: string
  avatarUrl: string | null
  displayName: string
  isAlt?: boolean
}

export default function OOCWhisperBubble({ content, avatarUrl, displayName, isAlt }: OOCWhisperBubbleProps) {
  const safeContent = useMemo(() => sanitizeRichHtml(content), [content])

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
          dangerouslySetInnerHTML={{ __html: safeContent }}
        />
      </div>
    </div>
  )
}
