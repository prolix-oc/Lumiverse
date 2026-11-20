import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldAlert } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import styles from './PermissionRequestModal.module.css'

function formatPermissionName(perm: string): string {
  return perm
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (ch) => ch.toUpperCase())
}

export default function PermissionRequestModal() {
  const { t } = useTranslation('modals')
  const request = useStore((s) => s.pendingPermissionRequest)
  const resolvePermissionRequest = useStore((s) => s.resolvePermissionRequest)
  const [granting, setGranting] = useState(false)

  useEffect(() => {
    if (!request) return
    setGranting(false)
  }, [request])

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

  return (
    <ModalShell isOpen={!!request} onClose={handleDeny} maxWidth={420} zIndex={10003} className={styles.modal}>
            {request && (
              <>
                <div className={styles.content}>
                  <div className={styles.iconWrap}>
                    <ShieldAlert size={24} />
                  </div>

                  <h3 className={styles.title}>{t('permissionRequest.title')}</h3>

                  <p className={styles.description}>
                    <span className={styles.extensionName}>{request.extensionName}</span>
                    {' '}
                    {request.permissions.length > 1
                      ? t('permissionRequest.requestingMany')
                      : t('permissionRequest.requestingOne')}
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
                    {t('permissionRequest.deny')}
                  </button>
                  <button
                    type="button"
                    className={styles.grantBtn}
                    onClick={handleGrant}
                    disabled={granting}
                  >
                    {granting ? t('permissionRequest.granting') : t('permissionRequest.grant')}
                  </button>
                </div>
              </>
            )}
    </ModalShell>
  )
}
