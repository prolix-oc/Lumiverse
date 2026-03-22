import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import { ShieldAlert } from 'lucide-react'
import { useStore } from '@/store'
import styles from './PermissionRequestModal.module.css'

function formatPermissionName(perm: string): string {
  return perm
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export default function PermissionRequestModal() {
  const request = useStore((s) => s.pendingPermissionRequest)
  const resolvePermissionRequest = useStore((s) => s.resolvePermissionRequest)
  const [granting, setGranting] = useState(false)

  useEffect(() => {
    if (!request) return
    setGranting(false)
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolvePermissionRequest(request.id, false)
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [request, resolvePermissionRequest])

  const handleDeny = useCallback(() => {
    if (!request) return
    resolvePermissionRequest(request.id, false)
  }, [request, resolvePermissionRequest])

  const handleGrant = useCallback(async () => {
    if (!request) return
    setGranting(true)
    try {
      await resolvePermissionRequest(request.id, true)
    } catch {
      setGranting(false)
    }
  }, [request, resolvePermissionRequest])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) handleDeny()
    },
    [handleDeny]
  )

  return createPortal(
    <AnimatePresence>
      {request && (
        <motion.div
          className={styles.backdrop}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={handleBackdropClick}
        >
          <motion.div
            className={styles.modal}
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            <div className={styles.content}>
              <div className={styles.iconWrap}>
                <ShieldAlert size={24} />
              </div>

              <h3 className={styles.title}>Permission Request</h3>

              <p className={styles.description}>
                <span className={styles.extensionName}>{request.extensionName}</span>
                {' '}is requesting the following permission{request.permissions.length > 1 ? 's' : ''}:
              </p>

              <div className={styles.permissionList}>
                {request.permissions.map((perm) => (
                  <span key={perm} className={styles.permPill}>
                    {formatPermissionName(perm)}
                  </span>
                ))}
              </div>

              {request.reason && (
                <p className={styles.reason}>
                  &ldquo;{request.reason}&rdquo;
                </p>
              )}
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.denyBtn}
                onClick={handleDeny}
                disabled={granting}
              >
                Deny
              </button>
              <button
                type="button"
                className={styles.grantBtn}
                onClick={handleGrant}
                disabled={granting}
              >
                {granting ? 'Granting...' : 'Grant'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
