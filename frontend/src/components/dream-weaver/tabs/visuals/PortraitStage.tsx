import type {
  DreamWeaverVisualAsset,
  DreamWeaverVisualJob,
} from '@/api/dream-weaver'
import styles from './PortraitStage.module.css'

interface PortraitStageProps {
  asset: DreamWeaverVisualAsset | null
  acceptedImageUrl: string | null
  candidateImageUrl: string | null
  activeJob: DreamWeaverVisualJob | null
  onAccept: () => void
  onDismiss: () => void
  onRegenerate: () => void
}

function getProgressMessage(job: DreamWeaverVisualJob | null): string | null {
  const message = job?.progress && typeof job.progress.message === 'string'
    ? job.progress.message
    : null
  if (message) return message
  if (job?.status === 'queued') return 'Queued for generation'
  if (job?.status === 'running') return 'Generating portrait'
  return null
}

export function PortraitStage({
  asset,
  acceptedImageUrl,
  candidateImageUrl,
  activeJob,
  onAccept,
  onDismiss,
  onRegenerate,
}: PortraitStageProps) {
  const progressMessage = getProgressMessage(activeJob)
  const errorMessage =
    activeJob?.status === 'failed' && typeof activeJob.error === 'string'
      ? activeJob.error
      : null

  if (candidateImageUrl) {
    const acceptLabel = acceptedImageUrl ? 'Replace Portrait' : 'Accept Portrait'

    return (
      <section className={styles.stage}>
        <div className={styles.stageHeader}>
          <div>
            <p className={styles.eyebrow}>Portrait</p>
            <h3 className={styles.title}>{asset?.label ?? 'Main Portrait'}</h3>
          </div>
          <span className={styles.status}>Candidate Ready</span>
        </div>
        <div className={styles.compareGrid}>
          <div className={styles.pane}>
            <div className={styles.paneLabel}>Accepted</div>
            {acceptedImageUrl ? (
              <img src={acceptedImageUrl} alt="Accepted portrait" className={styles.image} />
            ) : (
              <div className={styles.emptyImage}>No accepted portrait yet.</div>
            )}
          </div>
          <div className={styles.pane}>
            <div className={styles.paneLabel}>New Result</div>
            <img src={candidateImageUrl} alt="Candidate portrait" className={styles.image} />
            <div className={styles.actions}>
              <button type="button" className={styles.secondaryAction} onClick={onDismiss}>
                Dismiss
              </button>
              <button type="button" className={styles.secondaryAction} onClick={onRegenerate}>
                Regenerate
              </button>
              <button
                type="button"
                className={styles.primaryAction}
                onClick={onAccept}
              >
                {acceptLabel}
              </button>
            </div>
          </div>
        </div>
      </section>
    )
  }

  return (
    <section className={styles.stage}>
      <div className={styles.stageHeader}>
        <div>
          <p className={styles.eyebrow}>Portrait</p>
          <h3 className={styles.title}>{asset?.label ?? 'Main Portrait'}</h3>
        </div>
        {activeJob?.status === 'queued' || activeJob?.status === 'running' ? (
          <span className={styles.status}>Generating</span>
        ) : null}
      </div>

      <div className={styles.hero}>
        {acceptedImageUrl ? (
          <img src={acceptedImageUrl} alt={asset?.label ?? 'Accepted portrait'} className={styles.image} />
        ) : (
          <div className={styles.emptyImage}>
            <span className={styles.emptyTitle}>No portrait yet.</span>
            <span className={styles.emptyBody}>
              Choose the default image source, shape the prompts, then generate.
            </span>
          </div>
        )}

        {progressMessage && (
          <div className={styles.overlay}>
            <div className={styles.overlayBadge}>{progressMessage}</div>
          </div>
        )}
      </div>

      {errorMessage && (
        <div className={styles.errorBanner}>
          <span>{errorMessage}</span>
          <button type="button" className={styles.secondaryAction} onClick={onRegenerate}>
            Retry
          </button>
        </div>
      )}
    </section>
  )
}
