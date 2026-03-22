import styles from './OOCStyles.module.css'

interface OOCSocialCardProps {
  content: string
  avatarUrl: string | null
  displayName: string
}

export default function OOCSocialCard({ content, avatarUrl, displayName }: OOCSocialCardProps) {
  return (
    <div className={styles.socialCard}>
      <div className={styles.socialAvatarContainer}>
        {avatarUrl ? (
          <img className={styles.socialAvatar} src={avatarUrl} alt={displayName} />
        ) : (
          <div className={styles.socialAvatarPlaceholder}>
            {displayName.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      <div className={styles.socialContentColumn}>
        <div className={styles.socialHeaderRow}>
          <span className={styles.socialName}>{displayName}</span>
          <span className={styles.socialThread}>weaving through the Loom</span>
        </div>
        <div
          className={styles.socialContent}
          dangerouslySetInnerHTML={{ __html: content }}
        />
      </div>
    </div>
  )
}
