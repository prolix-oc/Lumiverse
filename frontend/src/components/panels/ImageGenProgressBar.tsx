import { useTranslation } from 'react-i18next'
import { useImageGenProgress } from '@/hooks/useImageGenProgress'
import styles from './ImageGenProgressBar.module.css'

interface Props {
  jobId: string | null
  showPreview?: boolean
}

export default function ImageGenProgressBar({ jobId, showPreview = true }: Props) {
  const { t } = useTranslation('panels', { keyPrefix: 'imageGenPanel.progress' })
  const progress = useImageGenProgress(jobId)
  const { step, totalSteps, preview, phase } = progress

  // Nothing to show until the first progress event arrives. Once generation has
  // started we stay mounted through the 'finalizing' phase so the last preview
  // frame bridges the gap until the panel swaps in the final image (and unmounts
  // this component by clearing the job id).
  if (phase === 'idle' && !preview) return null

  const finalizing = phase === 'finalizing'
  const pct = totalSteps > 0 ? Math.min(100, Math.round((step / totalSteps) * 100)) : 0
  const indeterminate = !finalizing && totalSteps <= 0

  return (
    <div className={styles.wrapper}>
      <div className={styles.headerRow}>
        <span className={styles.label}>{finalizing ? t('finalizing') : t('generating')}</span>
        <span className={styles.stepCount}>
          {finalizing ? null : indeterminate ? t('starting') : t('step', { step, total: totalSteps, pct })}
        </span>
      </div>
      <div className={styles.track}>
        <div
          className={`${styles.fill} ${indeterminate ? styles.fillIndeterminate : ''}`}
          style={indeterminate ? undefined : { width: `${finalizing ? 100 : pct}%` }}
        />
      </div>
      {showPreview && preview && <img className={styles.preview} src={preview} alt={t('previewAlt')} />}
    </div>
  )
}
