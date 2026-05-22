import { useEffect, useState } from 'react'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { imageGenApi } from '@/api/image-gen'
import styles from './ImagePromptPreviewModal.module.css'

interface ImagePromptPreviewProps {
  chatId: string
  initialPrompt: string
  initialNegativePrompt?: string
  initialPromptMode?: 'scene' | 'custom' | 'parsed_custom'
  initialPromptPresetId?: string | null
  promptGenerationTimeoutSeconds?: number
  onConfirm: (prompt: string, negativePrompt: string) => void
  onCancel: () => void
}

export default function ImagePromptPreviewModal() {
  const activeModal = useStore((s) => s.activeModal)
  const modalProps = useStore((s) => s.modalProps) as Partial<ImagePromptPreviewProps>
  const closeModal = useStore((s) => s.closeModal)

  const isOpen = activeModal === 'imagePromptPreview'

  const [prompt, setPrompt] = useState('')
  const [negative, setNegative] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    setPrompt(modalProps.initialPrompt || '')
    setNegative(modalProps.initialNegativePrompt || '')
    setError(null)
    setBusy(false)
  }, [isOpen, modalProps.initialPrompt, modalProps.initialNegativePrompt])

  if (!isOpen) return null

  const cancel = () => {
    modalProps.onCancel?.()
    closeModal()
  }

  const confirm = () => {
    if (!prompt.trim()) {
      setError('Prompt cannot be empty')
      return
    }
    modalProps.onConfirm?.(prompt, negative)
    closeModal()
  }

  const regenerate = async () => {
    if (!modalProps.chatId) return
    setBusy(true)
    setError(null)
    try {
      const res = await imageGenApi.previewPrompt({
        chatId: modalProps.chatId,
        promptMode: modalProps.initialPromptMode,
        promptPresetId: modalProps.initialPromptPresetId ?? null,
        promptGenerationTimeoutSeconds: modalProps.promptGenerationTimeoutSeconds,
      })
      setPrompt(res.prompt || '')
      setNegative(res.negativePrompt || '')
    } catch (err: any) {
      setError(err?.message || 'Failed to regenerate prompt')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalShell isOpen={isOpen} onClose={cancel} maxWidth={640} maxHeight="85vh" className={styles.modal}>
      <div className={styles.header}>
        <h3 className={styles.title}>Preview &amp; Edit Image Prompt</h3>
        <p className={styles.subtitle}>
          This is the prompt that will be sent to the image generator. Edit it freely — the parser will be skipped on confirm.
        </p>
      </div>

      <div className={styles.body}>
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Prompt</label>
          <textarea
            className={styles.textarea}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="The final image prompt"
            autoFocus
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label}>Negative Prompt</label>
          <textarea
            className={`${styles.textarea} ${styles.textareaShort}`}
            value={negative}
            onChange={(e) => setNegative(e.target.value)}
            placeholder="Optional negative prompt"
          />
        </div>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnCancel}`} onClick={cancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSecondary}`}
            onClick={regenerate}
            disabled={busy}
          >
            {busy ? 'Regenerating…' : 'Re-run parser'}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSubmit}`}
            onClick={confirm}
            disabled={busy || !prompt.trim()}
          >
            Generate
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
