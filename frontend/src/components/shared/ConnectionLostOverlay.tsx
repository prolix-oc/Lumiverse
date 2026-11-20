import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { WifiOff, Download } from 'lucide-react'
import { useStore } from '@/store'
import { Spinner } from './Spinner'
import styles from './ConnectionLostOverlay.module.css'

// A single close event is routine on mobile resume and during network handoff.
// Give the transport time to enter its explicit recovery state before blocking
// the whole application. Authentication/update failures remain immediate.
const CONNECTION_FAILURE_GRACE_MS = 5_000

function blockInteraction(event: SyntheticEvent) {
  event.preventDefault()
  event.stopPropagation()
}

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
  const connectionUnavailable =
    isAuthenticated && wsHasEverConnected && !healthy
  const [showConnectionFailure, setShowConnectionFailure] = useState(false)
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!connectionUnavailable) {
      setShowConnectionFailure(false)
      return
    }

    // Resume recovery only suppresses the overlay before it appears. Once the
    // user has been hard-stopped, keep it latched until all health checks pass;
    // focusing/tapping the app can itself start resume recovery and must not
    // make the overlay disappear during that attempt.
    if (showConnectionFailure || wsResumeRecovering) return

    const timer = window.setTimeout(
      () => setShowConnectionFailure(true),
      CONNECTION_FAILURE_GRACE_MS,
    )
    return () => window.clearTimeout(timer)
  }, [connectionUnavailable, showConnectionFailure, wsResumeRecovering])

  const visible =
    isAuthenticated &&
    (wsUpdatePending || showConnectionFailure)

  useEffect(() => {
    if (!visible) return

    const overlay = backdropRef.current
    if (!overlay) return

    // The backdrop catches pointer input, while `inert` also blocks keyboard,
    // focus, and any higher-z-index portal that was already mounted. Keep the
    // desktop titlebar's root interactive so a disconnected/updating window
    // can still be moved or closed, and inert the app surface inside it
    // instead. Preserve pre-existing inert state so stacked modal cleanup
    // remains correct.
    const blockedSiblings = new Map<Element, string | null>()
    const blockSibling = (element: Element) => {
      if (element === overlay || blockedSiblings.has(element)) return
      blockedSiblings.set(element, element.getAttribute('inert'))
      element.setAttribute('inert', '')
    }
    const blockBodySiblings = () => {
      const titlebar = document.querySelector('[data-component="DesktopPwaTitlebar"]')
      const appRoot = document.querySelector('[data-app-root]')
      if (appRoot) blockSibling(appRoot)

      for (const element of document.body.children) {
        if (titlebar && element.contains(titlebar)) continue
        blockSibling(element)
      }
    }

    blockBodySiblings()
    const observer = new window.MutationObserver(blockBodySiblings)
    observer.observe(document.body, { childList: true })

    const previouslyFocused = document.activeElement as HTMLElement | null
    overlay.focus({ preventScroll: true })

    return () => {
      observer.disconnect()
      for (const [element, previousInert] of blockedSiblings) {
        if (previousInert === null) element.removeAttribute('inert')
        else element.setAttribute('inert', previousInert)
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true })
    }
  }, [visible])

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
          ref={backdropRef}
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="connection-lost-title"
          aria-describedby="connection-lost-message"
          tabIndex={-1}
          onPointerDown={blockInteraction}
          onClick={blockInteraction}
          onContextMenu={blockInteraction}
          onKeyDown={blockInteraction}
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
