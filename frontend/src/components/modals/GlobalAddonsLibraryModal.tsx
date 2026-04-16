import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, Check, Trash2, Copy, Globe } from 'lucide-react'
import { ModalShell } from '@/components/shared/ModalShell'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { useStore } from '@/store'
import { globalAddonsApi } from '@/api/global-addons'
import { toast } from '@/lib/toast'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import type { GlobalAddon } from '@/types/api'
import styles from './GlobalAddonsLibraryModal.module.css'
import clsx from 'clsx'

export default function GlobalAddonsLibraryModal() {
  const closeModal = useStore((s) => s.closeModal)

  const [addons, setAddons] = useState<GlobalAddon[]>([])
  const [loading, setLoading] = useState(true)
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    globalAddonsApi.list({ limit: 200, offset: 0 })
      .then((res) => setAddons(res.data))
      .catch(() => toast.error('Failed to load global add-ons'))
      .finally(() => setLoading(false))
  }, [])

  const debouncedUpdate = useCallback((id: string, input: Partial<{ label: string; content: string }>) => {
    const existing = saveTimers.current.get(id)
    if (existing) clearTimeout(existing)
    saveTimers.current.set(id, setTimeout(async () => {
      try {
        const updated = await globalAddonsApi.update(id, input)
        setAddons((prev) => prev.map((a) => a.id === id ? updated : a))
      } catch {
        toast.error('Failed to save add-on')
      }
      saveTimers.current.delete(id)
    }, 300))
  }, [])

  const handleAdd = useCallback(async () => {
    try {
      const addon = await globalAddonsApi.create({ label: '', content: '', sort_order: addons.length })
      setAddons((prev) => [...prev, addon])
    } catch {
      toast.error('Failed to create add-on')
    }
  }, [addons.length])

  const handleDelete = useCallback(async (id: string) => {
    try {
      await globalAddonsApi.delete(id)
      setAddons((prev) => prev.filter((a) => a.id !== id))
    } catch {
      toast.error('Failed to delete add-on')
    }
  }, [])

  const handleDuplicate = useCallback(async (id: string) => {
    try {
      const addon = await globalAddonsApi.duplicate(id)
      setAddons((prev) => [...prev, addon])
    } catch {
      toast.error('Failed to duplicate add-on')
    }
  }, [])

  const handleLabelChange = useCallback((id: string, label: string) => {
    setAddons((prev) => prev.map((a) => a.id === id ? { ...a, label } : a))
    debouncedUpdate(id, { label })
  }, [debouncedUpdate])

  const handleContentChange = useCallback((id: string, content: string) => {
    setAddons((prev) => prev.map((a) => a.id === id ? { ...a, content } : a))
    debouncedUpdate(id, { content })
  }, [debouncedUpdate])

  return (
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={580} className={styles.modal}>
      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <Globe size={15} className={styles.headerIcon} />
          <span className={styles.title}>Global Add-Ons Library</span>
        </div>
        <CloseButton onClick={closeModal} size="sm" />
      </div>

      {/* Body */}
      <div className={styles.body}>
        {loading && <div className={styles.empty}>Loading...</div>}
        {!loading && addons.length === 0 && (
          <div className={styles.empty}>
            No global add-ons yet. Global add-ons can be attached to any persona,
            making them reusable across your entire library.
          </div>
        )}
        {addons.map((addon) => (
          <div key={addon.id} className={styles.addonCard}>
            <div className={styles.addonTopRow}>
              <div className={styles.globalIndicator}>
                <Globe size={11} />
              </div>
              <input
                type="text"
                className={styles.addonLabelInput}
                value={addon.label}
                onChange={(e) => handleLabelChange(addon.id, e.target.value)}
                placeholder="Add-on name..."
              />
              <button
                type="button"
                className={styles.addonActionBtn}
                onClick={() => handleDuplicate(addon.id)}
                title="Duplicate add-on"
              >
                <Copy size={13} />
              </button>
              <button
                type="button"
                className={clsx(styles.addonActionBtn, styles.addonDeleteBtn)}
                onClick={() => handleDelete(addon.id)}
                title="Delete add-on"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <ExpandableTextarea
              className={styles.addonContent}
              value={addon.content}
              onChange={(v) => handleContentChange(addon.id, v)}
              title={addon.label || 'Global Add-On Content'}
              placeholder="Add-on content (appended to persona description when enabled)..."
              rows={2}
            />
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className={styles.footer}>
        <Button variant="primary" icon={<Plus size={13} />} onClick={handleAdd}>
          Add Global Add-On
        </Button>
        <span className={styles.addonCount}>
          {addons.length} add-on{addons.length !== 1 ? 's' : ''}
        </span>
      </div>
    </ModalShell>
  )
}
