import { Check, Sparkles, Wand2 } from 'lucide-react'
import { Spinner } from '@/components/shared/Spinner'
import { WEAVING_OPERATIONS } from '../lib/studio-model'
import styles from './WeavingOverlay.module.css'

interface WeavingOverlayProps {
  operation: 'soul' | 'world' | 'finalize'
  currentStepIndex: number
}

export function WeavingOverlay({ operation, currentStepIndex }: WeavingOverlayProps) {
  const config = WEAVING_OPERATIONS[operation]

  return (
    <div className={styles.weavingState}>
      <div className={styles.weavingGlyph} aria-hidden="true">
        <span className={styles.weavingHalo} />
        <span className={styles.weavingCore}>
          <Sparkles size={18} />
        </span>
      </div>
      <div className={styles.weavingCopy}>
        <p className={styles.weavingEyebrow}>Dream Weaver</p>
        <h3 className={styles.weavingTitle}>{config.title}</h3>
        <p className={styles.weavingText}>{config.description}</p>
      </div>
      <div className={styles.weavingSteps} aria-label="Generation stages">
        {config.steps.map((label, index) => {
          const status =
            currentStepIndex < 0
              ? 'pending'
              : index < currentStepIndex
                ? 'completed'
                : index === currentStepIndex
                  ? 'active'
                  : 'pending'

          return (
            <div key={index} className={styles.weavingStep} data-status={status}>
              {status === 'completed' ? (
                <Check size={14} />
              ) : status === 'active' ? (
                <Spinner size={14} />
              ) : (
                <Wand2 size={14} />
              )}
              <span>{label}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
