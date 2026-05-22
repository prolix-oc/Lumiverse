import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X } from 'lucide-react'
import { useStore } from '@/store'
import SpindleFloatWidget from './SpindleFloatWidget'
import SpindleDockPanel from './SpindleDockPanel'
import SpindleAppMount from './SpindleAppMount'
import ExpandedTextEditor from '@/components/shared/ExpandedTextEditor'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import { InputPromptModal } from '@/components/shared/InputPromptModal'
import ContextMenu, { type ContextMenuEntry } from '@/components/shared/ContextMenu'
import type { SpindleModalItem } from '@/types/store'

function SpindleTextEditor() {
  const reqId = useStore((s) => s.pendingTextEditor?.requestId ?? null)
  const req = useStore((s) => s.pendingTextEditor)
  const closeTextEditor = useStore((s) => s.closeTextEditor)
  const [value, setValue] = useState('')
  const reqRef = useRef(req)
  const valueRef = useRef(value)
  reqRef.current = req
  valueRef.current = value

  useEffect(() => {
    if (req) setValue(req.value ?? '')
  }, [reqId])

  // Stable close handler — never changes identity, reads from refs
  const handleClose = useRef(() => {
    const r = reqRef.current
    if (!r) return
    closeTextEditor(r.requestId, valueRef.current, false)
  })
  handleClose.current = () => {
    const r = reqRef.current
    if (!r) return
    closeTextEditor(r.requestId, valueRef.current, false)
  }

  const onClose = useCallback(() => handleClose.current(), [])

  if (!req) return null

  return (
    <ExpandedTextEditor
      value={value}
      onChange={setValue}
      onClose={onClose}
      title={req.title}
      placeholder={req.placeholder}
    />
  )
}

export default function SpindleUIManager() {
  const floatWidgets = useStore((s) => s.floatWidgets)
  const dockPanels = useStore((s) => s.dockPanels)
  const appMounts = useStore((s) => s.appMounts)
  const hiddenPlacements = useStore((s) => s.hiddenPlacements)

  return (
    <>
      {floatWidgets
        .filter((w) => w.visible && !hiddenPlacements.includes(w.id))
        .map((w) => (
          <SpindleFloatWidget key={w.id} widget={w} />
        ))}

      {dockPanels
        .filter((p) => !hiddenPlacements.includes(p.id))
        .map((p) => (
          <SpindleDockPanel key={p.id} panel={p} />
        ))}

      {appMounts
        .filter((m) => !hiddenPlacements.includes(m.id))
        .map((m) => (
          <SpindleAppMount key={m.id} mount={m} />
        ))}

      <SpindleTextEditor />
      <SpindleModal />
      <SpindleConfirm />
      <SpindleInputPrompt />
      <SpindleContextMenu />
    </>
  )
}

function ModalItemRenderer({ item }: { item: SpindleModalItem }) {
  switch (item.type) {
    case 'text':
      return (
        <p style={{ margin: 0, fontSize: 13, color: item.muted ? 'var(--lumiverse-text-dim)' : 'var(--lumiverse-text)', whiteSpace: 'pre-wrap' }}>
          {item.content}
        </p>
      )
    case 'divider':
      return <hr style={{ border: 'none', borderTop: '1px solid var(--lumiverse-border)', margin: '8px 0' }} />
    case 'key_value':
      return (
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, gap: 12 }}>
          <span style={{ color: 'var(--lumiverse-text-dim)' }}>{item.label}</span>
          <span style={{ color: 'var(--lumiverse-text)', fontWeight: 500, textAlign: 'right' }}>{item.value}</span>
        </div>
      )
    case 'heading':
      return <h4 style={{ margin: '4px 0 0', fontSize: 14, fontWeight: 600, color: 'var(--lumiverse-text)' }}>{item.content}</h4>
    case 'card':
      return (
        <div style={{ padding: 12, borderRadius: 8, border: '1px solid var(--lumiverse-border)', background: 'var(--lumiverse-fill-subtle)', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {item.items.map((child, i) => <ModalItemRenderer key={i} item={child} />)}
        </div>
      )
    default:
      return null
  }
}

function SpindleModal() {
  const req = useStore((s) => s.pendingModal)
  const closeModal = useStore((s) => s.closeSpindleModal)

  if (!req) return null

  const handleBackdrop = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !req.persistent) {
      closeModal(req.requestId, 'user')
    }
  }

  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      onClick={handleBackdrop}
      style={{
        position: 'fixed', inset: 0, zIndex: 10003,
        width: 'var(--app-scaled-viewport-width, calc(100vw / var(--lumiverse-ui-scale, 1)))',
        height: 'var(--app-scaled-viewport-height, calc(100vh / var(--lumiverse-ui-scale, 1)))',
        background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.15 }}
        style={{
          width: Math.min(req.width || 420, window.innerWidth - 40),
          maxHeight: Math.min(req.maxHeight || 520, window.innerHeight - 40),
          background: 'var(--lumiverse-bg)', borderRadius: 12,
          border: '1px solid var(--lumiverse-border)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--lumiverse-border)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--lumiverse-text)' }}>{req.title}</h3>
            <span style={{ fontSize: 11, color: 'var(--lumiverse-text-muted)' }}>{req.extensionName}</span>
          </div>
          {!req.persistent && (
            <button
              type="button"
              onClick={() => closeModal(req.requestId, 'user')}
              style={{ background: 'none', border: 'none', color: 'var(--lumiverse-text-dim)', cursor: 'pointer', padding: 4, borderRadius: 4 }}
            >
              <X size={16} />
            </button>
          )}
        </div>
        <div style={{ padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {req.items.map((item, i) => <ModalItemRenderer key={i} item={item} />)}
        </div>
      </motion.div>
    </motion.div>,
    document.body
  )
}

function SpindleConfirm() {
  const req = useStore((s) => s.pendingConfirm)
  const closeConfirm = useStore((s) => s.closeSpindleConfirm)

  if (!req) return null

  const variantMap: Record<string, 'danger' | 'warning' | 'safe'> = {
    danger: 'danger',
    warning: 'warning',
    info: 'safe',
    success: 'safe',
  }

  return (
    <ConfirmationModal
      isOpen={true}
      title={`${req.extensionName}: ${req.title}`}
      message={req.message}
      variant={variantMap[req.variant] || 'safe'}
      confirmText={req.confirmLabel}
      cancelText={req.cancelLabel}
      onConfirm={() => closeConfirm(req.requestId, true)}
      onCancel={() => closeConfirm(req.requestId, false)}
      zIndex={10004}
    />
  )
}

function SpindleInputPrompt() {
  const req = useStore((s) => s.pendingInputPrompt)
  const closeInputPrompt = useStore((s) => s.closeInputPrompt)

  if (!req) return null

  return (
    <InputPromptModal
      isOpen={true}
      title={req.title}
      attribution={req.extensionName}
      message={req.message}
      placeholder={req.placeholder}
      defaultValue={req.defaultValue}
      submitLabel={req.submitLabel}
      cancelLabel={req.cancelLabel}
      multiline={req.multiline}
      onSubmit={(value) => closeInputPrompt(req.requestId, value)}
      onCancel={() => closeInputPrompt(req.requestId, null)}
      zIndex={10004}
    />
  )
}

function SpindleContextMenu() {
  const req = useStore((s) => s.pendingContextMenu)
  const closeContextMenu = useStore((s) => s.closeContextMenu)

  const items: ContextMenuEntry[] = useMemo(() => {
    if (!req) return []
    return req.items.map((item) => {
      if (item.type === 'divider') {
        return { key: item.key, type: 'divider' as const }
      }
      return {
        key: item.key,
        label: item.label,
        disabled: item.disabled,
        danger: item.danger,
        active: item.active,
        onClick: () => closeContextMenu(req.requestId, item.key),
      }
    })
  }, [req, closeContextMenu])

  if (!req) return null

  return (
    <ContextMenu
      position={req.position}
      items={items}
      onClose={() => closeContextMenu(req.requestId, null)}
    />
  )
}
