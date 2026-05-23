import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { WifiOff, Download } from 'lucide-react'
import { useStore } from '@/store'
import { Spinner } from './Spinner'
import styles from './ConnectionLostOverlay.module.css'

/**
 * Grace window after a hidden→visible transition where we suppress the
 * overlay so iOS PWAs (and any other browser that silently kills the WS during
 * suspension) can finish their recovery dance without flashing the screen at
 * the user. Tuned to comfortably cover: fast-watchdog timeout (3s) + scheduled
 * reconnect delay (3s) + handshake (~200ms) = ~6.2s worst case.
 */
const RESUME_GRACE_MS = 7_000

/**
 * Full-screen, non-dismissable overlay shown when the WebSocket connection to
 * the backend has dropped after the user was already authenticated and using
 * the app. Auto-dismisses once all three healthy signals coincide:
 *   1. Socket OPEN (wsConnected)
 *   2. Backend CONNECTED event with role received (wsAuthSynced)
 *   3. Pong received since the last open (wsRoundTripVerified)
 *
 * The overlay is suppressed until the user has had at least one fully healthy
 * connection in this session (wsHasEverConnected) — that prevents a flash
 * during cold start, login, or page refresh.
 */
export default function ConnectionLostOverlay() {
  const isAuthenticated = useStore((s) => s.isAuthenticated)
  const wsConnected = useStore((s) => s.wsConnected)
  const wsAuthSynced = useStore((s) => s.wsAuthSynced)
  const wsRoundTripVerified = useStore((s) => s.wsRoundTripVerified)
  const wsHasEverConnected = useStore((s) => s.wsHasEverConnected)
  const wsUpdatePending = useStore((s) => s.wsUpdatePending)

  // Grace state used only for hidden→visible recoveries — see RESUME_GRACE_MS.
  const [inResumeGrace, setInResumeGrace] = useState(false)
  // Snapshot whether the overlay was visible right before the page went hidden.
  // If it was, we DON'T grant grace on resume — hiding an already-shown overlay
  // for 7s only to re-show it would be more jarring than the current behavior.
  const overlayWasShowingAtHideRef = useRef(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const onVisChange = () => {
      if (document.visibilityState === 'hidden') {
        const state = useStore.getState()
        const healthyNow = state.wsConnected && state.wsAuthSynced && state.wsRoundTripVerified
        overlayWasShowingAtHideRef.current =
          state.isAuthenticated && state.wsHasEverConnected && !healthyNow
      } else if (document.visibilityState === 'visible') {
        if (!overlayWasShowingAtHideRef.current) {
          setInResumeGrace(true)
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => setInResumeGrace(false), RESUME_GRACE_MS)
        }
        overlayWasShowingAtHideRef.current = false
      }
    }

    document.addEventListener('visibilitychange', onVisChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisChange)
      if (timer) clearTimeout(timer)
    }
  }, [])

  const healthy = wsConnected && wsAuthSynced && wsRoundTripVerified
  // wsUpdatePending forces the overlay to stay up through the bundle swap, so
  // the user never sees a flash of normal UI before the page reloads.
  // wsUpdatePending also bypasses the resume grace — an actual update needs to
  // be communicated even if we just resumed from the background.
  const visible =
    isAuthenticated &&
    (wsUpdatePending || (wsHasEverConnected && !healthy && !inResumeGrace))

  const title = wsUpdatePending ? 'Updating Lumiverse' : 'Server connection lost'
  const message = wsUpdatePending
    ? 'A new version is available. Applying the update — the page will refresh in a moment.'
    : wsConnected
      ? wsAuthSynced
        ? 'Verifying connection…'
        : 'Re-syncing your session…'
      : 'The server has become unreachable. We’ll automatically restore your session as soon as it’s back.'
  const statusText = wsUpdatePending
    ? 'Installing latest bundle…'
    : wsConnected
      ? 'Verifying…'
      : 'Attempting to reconnect…'

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
