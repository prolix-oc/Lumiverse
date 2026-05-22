import { useMemo } from 'react'
import clsx from 'clsx'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import styles from './OOCStyles.module.css'

interface OOCMarginNoteProps {
  content: string
  avatarUrl: string | null
  displayName: string
  isAlt?: boolean
}

export default function OOCMarginNote({ content, avatarUrl, displayName, isAlt }: OOCMarginNoteProps) {
  const safeContent = useMemo(() => sanitizeRichHtml(content), [content])

  return (
    <div className={clsx(styles.marginNote, isAlt && styles.marginNoteAlt)}>
      <div className={styles.marginTag}>
        {avatarUrl ? (
          <img className={styles.marginTagAvatar} src={avatarUrl} alt={displayName} />
        ) : (
          <span className={styles.marginTagLetter}>
            {displayName.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <div className={styles.marginContentArea}>
        <div className={styles.marginLabel}>{displayName}</div>
        <div
          className={styles.marginText}
          dangerouslySetInnerHTML={{ __html: safeContent }}
        />
      </div>
    </div>
  )
}
