import { useImageGenProgress } from '@/hooks/useImageGenProgress'
import styles from './ImageGenProgressBar.module.css'

interface Props {
  jobId: string | null
  showPreview?: boolean
}

export default function ImageGenProgressBar({ jobId, showPreview = true }: Props) {
  const progress = useImageGenProgress(jobId)
  if (!progress.isGenerating) return null

  const { step, totalSteps, preview } = progress
  const pct = totalSteps > 0 ? Math.min(100, Math.round((step / totalSteps) * 100)) : 0
  const indeterminate = totalSteps <= 0

  return (
    <div className={styles.wrapper}>
      <div className={styles.headerRow}>
        <span className={styles.label}>Generating image…</span>
        <span className={styles.stepCount}>
          {indeterminate ? 'starting…' : `${step}/${totalSteps} (${pct}%)`}
        </span>
      </div>
      <div className={styles.track}>
        <div
          className={`${styles.fill} ${indeterminate ? styles.fillIndeterminate : ''}`}
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
      {showPreview && preview && <img className={styles.preview} src={preview} alt="Generation preview" />}
    </div>
  )
}
