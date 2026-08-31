import { useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { Button } from './FormComponents'
import styles from './ConnectionReviewStatus.module.css'

export interface ConnectionReviewState {
  review_required?: boolean
  review_code?: string | null
}

export function connectionNeedsReview(profile: ConnectionReviewState): boolean {
  return profile.review_required === true
}

interface ConnectionReviewStatusProps {
  profile: ConnectionReviewState
  onReview: () => Promise<void> | void
  /** Stable control to focus after the review banner unmounts. */
  focusTargetRef?: RefObject<HTMLElement | null>
}
const REVIEW_REASON_KEYS = {
  foreign_import: 'foreignImport',
  repair_required: 'repairRequired',
  malformed_import: 'repairRequired',
} as const
export function focusConnectionReviewTarget(target: RefObject<HTMLElement | null> | undefined): void {
  target?.current?.focus()
}

function reviewReasonKey(code: string | null): keyof typeof REVIEW_REASON_KEYS | null {
  if (!code) return null
  return Object.hasOwn(REVIEW_REASON_KEYS, code) ? code as keyof typeof REVIEW_REASON_KEYS : null
}
export default function ConnectionReviewStatus({ profile, onReview, focusTargetRef }: ConnectionReviewStatusProps) {
  const { t } = useTranslation('panels')
  const [reviewing, setReviewing] = useState(false)
  if (!connectionNeedsReview(profile)) return null

  const handleReview = async () => {
    if (reviewing) return
    setReviewing(true)
    try {
      await onReview()
      // The banner normally disappears when the parent applies the reviewed
      // profile. Restore keyboard position to a stable row control rather
      // than leaving focus on the removed Enable button.
      window.requestAnimationFrame(() => focusConnectionReviewTarget(focusTargetRef))
    } finally {
      setReviewing(false)
    }
  }
  const code = typeof profile.review_code === 'string' && profile.review_code.trim().length > 0
    ? profile.review_code.trim()
    : null
  const reasonKey = reviewReasonKey(code)
  const reason = reasonKey
    ? t(`connectionReview.reasons.${REVIEW_REASON_KEYS[reasonKey]}`)
    : t('connectionReview.reasons.unknown')

  return (
    <div className={styles.status} role="alert">
      <ShieldAlert size={16} aria-hidden="true" />
      <div className={styles.copy}>
        <strong>{t('connectionReview.title')}</strong>
        <span>{t('connectionReview.description')}</span>
        <span>{reason}</span>
      </div>
      <Button
        variant="primary"
        size="sm"
        onClick={() => void handleReview()}
        disabled={reviewing}
        aria-label={t('connectionReview.enable')}
      >
        {reviewing ? t('connectionReview.enabling') : t('connectionReview.enable')}
      </Button>
    </div>
  )
}
