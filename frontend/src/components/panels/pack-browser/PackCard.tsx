import { useTranslation } from 'react-i18next'
import type { Pack } from '@/types/api'
import LazyImage from '@/components/shared/LazyImage'
import { Badge } from '@/components/shared/Badge'
import styles from './PackBrowser.module.css'

interface Props {
  pack: Pack
  onClick: (pack: Pack) => void
}

export default function PackCard({ pack, onClick }: Props) {
  'use memo'

  const { t } = useTranslation('panels')
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
        {pack.author && <div className={styles.cardAuthor}>{t('packBrowser.packCard.byAuthor', { author: pack.author })}</div>}
        <div className={styles.cardBadges}>
          <Badge color={pack.is_custom ? 'primary' : 'success'} size="sm">
            {pack.is_custom ? t('packBrowser.packCard.badgeCustom') : t('packBrowser.packCard.badgeDownloaded')}
          </Badge>
          <Badge size="sm">v{pack.version}</Badge>
        </div>
      </div>
    </div>
  )
}
