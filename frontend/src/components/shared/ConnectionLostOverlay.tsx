import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { WifiOff, Download } from 'lucide-react'
import { useStore } from '@/store'
import { Spinner } from './Spinner'
import styles from './ConnectionLostOverlay.module.css'

export default function ConnectionLostOverlay() {
  const { t } = useTranslation('shared')
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const wsConnected = useStore((s) => s.wsConnected)
  const wsAuthSynced = useStore((s) => s.wsAuthSynced)
  const wsRoundTripVerified = useStore((s) => s.wsRoundTripVerified)
  const wsHasEverConnected = useStore((s) => s.wsHasEverConnected)
  const wsUpdatePending = useStore((s) => s.wsUpdatePending)
  const wsResumeRecovering = useStore((s) => s.wsResumeRecovering)

  const healthy = wsConnected && wsAuthSynced && wsRoundTripVerified
  const visible =
    isAuthenticated &&
    (wsUpdatePending || (wsHasEverConnected && !healthy && !wsResumeRecovering))

  const title = wsUpdatePending
    ? t('connectionLost.updatingTitle')
    : t('connectionLost.lostTitle')
  const message = wsUpdatePending
    ? t('connectionLost.updatingMessage')
    : wsConnected
      ? wsAuthSynced
        ? t('connectionLost.verifyingConnection')
        : t('connectionLost.resyncingSession')
      : t('connectionLost.unreachable')
  const statusText = wsUpdatePending
    ? t('connectionLost.installingBundle')
    : wsConnected
      ? t('connectionLost.verifying')
      : t('connectionLost.reconnecting')

  return createPortal(
    <AnimatePresence>
      {visible && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="connection-lost-title"
          aria-describedby="connection-lost-message"
        >
          <motion.div
            className={styles.card}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
          >
            <div
              className={wsUpdatePending ? styles.iconRingUpdate : styles.iconRing}
              aria-hidden="true"
            >
              <span className={styles.pulse} />
              {wsUpdatePending ? (
                <Download size={28} strokeWidth={2} />
              ) : (
                <WifiOff size={28} strokeWidth={2} />
              )}
            </div>
            <h2 id="connection-lost-title" className={styles.title}>
              {title}
            </h2>
            <p id="connection-lost-message" className={styles.message}>
              {message}
            </p>
            <span className={styles.status}>
              <Spinner size={14} />
              {statusText}
            </span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}
