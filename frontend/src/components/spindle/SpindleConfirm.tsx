import { useStore } from '@/store'
import ConfirmationModal from '@/components/shared/ConfirmationModal'

export default function SpindleConfirm() {
  const req = useStore((s) => s.pendingConfirm)
  const closeConfirm = useStore((s) => s.closeSpindleConfirm)
  if (!req) return null
  const variants: Record<string, 'danger' | 'warning' | 'safe'> = {
    danger: 'danger', warning: 'warning', info: 'safe', success: 'safe',
  }
  return (
    <ConfirmationModal
      key={req.requestId}
      isOpen={true}
      title={`${req.extensionName}: ${req.title}`}
      message={req.message}
      variant={variants[req.variant] || 'safe'}
      confirmText={req.confirmLabel}
      cancelText={req.cancelLabel}
      checkboxLabel={req.checkboxLabel}
      onConfirm={(_, checked) => closeConfirm(req.requestId, true, checked)}
      onCancel={() => closeConfirm(req.requestId, false)}
      zIndex={10004}
    />
  )
}
