import type { Pack } from '@/types/api'
import LazyImage from '@/components/shared/LazyImage'
import styles from './PackBrowser.module.css'
import clsx from 'clsx'

interface Props {
  pack: Pack
  onClick: (pack: Pack) => void
}

export default function PackCard({ pack, onClick }: Props) {
  const initial = pack.name.charAt(0) || '?'

  return (
    <div className={styles.card} onClick={() => onClick(pack)}>
      <div className={styles.cardCover}>
        <LazyImage
          src={pack.cover_url}
          alt={pack.name}
          fallback={<div className={styles.cardCoverFallback}>{initial}</div>}
        />
      </div>
      <div className={styles.cardBody}>
        <div className={styles.cardName}>{pack.name}</div>
        {pack.author && <div className={styles.cardAuthor}>by {pack.author}</div>}
        <div className={styles.cardBadges}>
          <span className={clsx(styles.badge, pack.is_custom ? styles.badgeCustom : styles.badgeDownloaded)}>
            {pack.is_custom ? 'Custom' : 'Downloaded'}
          </span>
          <span className={styles.badge}>v{pack.version}</span>
        </div>
      </div>
    </div>
  )
}
