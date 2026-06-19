import { useCallback, useEffect, useRef, useState } from 'react'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { imageGenApi } from '@/api/image-gen'
import { copyTextToClipboard } from '@/lib/clipboard'
import { getCharacterAvatarUrl, getPersonaAvatarUrl } from '@/lib/avatarUrls'
import type { ImageGenPromptPreset } from '@/types/store'
import styles from './ImageCaptionModal.module.css'

const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
const MAX_SIZE_BYTES = 20 * 1024 * 1024

async function fetchImageAsBase64(url: string): Promise<{ data: string; mime: string }> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`)
  const blob = await res.blob()
  const mime = blob.type || 'image/png'
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({ data: dataUrl.slice(dataUrl.indexOf(',') + 1), mime })
    }
    reader.onerror = () => reject(new Error('Failed to read image data'))
    reader.readAsDataURL(blob)
  })
}

export default function ImageCaptionModal() {
  const activeModal = useStore((s) => s.activeModal)
  const closeModal = useStore((s) => s.closeModal)
  const promptPresets = useStore((s) => s.imageGeneration?.promptPresets || [])
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const characters = useStore((s) => s.characters)
  const activePersonaId = useStore((s) => s.activePersonaId)
  const personas = useStore((s) => s.personas)

  const activeCharacter = activeCharacterId ? characters.find((c) => c.id === activeCharacterId) : null
  const activePersona = activePersonaId ? personas.find((p) => p.id === activePersonaId) : null
  const hasCharacterAvatar = !!(activeCharacter?.image_id || activeCharacter?.avatar_path)
  const hasPersonaAvatar = !!(activePersona?.image_id || (activePersona as any)?.avatar_path)

  const isOpen = activeModal === 'imageCaptioner'

  const [imageData, setImageData] = useState<string | null>(null)
  const [imageMime, setImageMime] = useState<string>('image/png')
  const [prompt, setPrompt] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [caption, setCaption] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [loadingAvatar, setLoadingAvatar] = useState(false)

  const captioningPresets = promptPresets.filter(
    (p: ImageGenPromptPreset) => p.kind === 'captioning',
  )

  useEffect(() => {
    if (!isOpen) return
    setImageData(null)
    setImageMime('image/png')
    setPrompt('')
    setSelectedPresetId(null)
    setCaption('')
    setError(null)
    setBusy(false)
    setCopied(false)
  }, [isOpen])

  const loadFile = useCallback((file: File) => {
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError(`Unsupported format: ${file.type}. Use PNG, JPEG, WebP, or GIF.`)
      return
    }
    if (file.size > MAX_SIZE_BYTES) {
      setError('Image exceeds 20 MB limit.')
      return
    }
    setError(null)
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const commaIdx = dataUrl.indexOf(',')
      setImageData(dataUrl.slice(commaIdx + 1))
      setImageMime(file.type)
    }
    reader.readAsDataURL(file)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files?.[0]
      if (file) loadFile(file)
    },
    [loadFile],
  )

  // Listen for paste at the document level while the modal is open. The modal is
  // portalled to document.body and nothing inside it is autofocused, so a fresh
  // Ctrl+V dispatches to document.body — an ancestor of the modal — and never
  // reaches an onPaste on the modal's own DOM. A document listener catches the
  // paste regardless of focus, mirroring the always-focused chat input textarea.
  useEffect(() => {
    if (!isOpen) return
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            loadFile(file)
            return
          }
        }
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [isOpen, loadFile])

  const loadAvatar = useCallback(async (kind: 'character' | 'persona') => {
    const url = kind === 'character'
      ? getCharacterAvatarUrl(activeCharacter)
      : getPersonaAvatarUrl(activePersona)
    if (!url) return
    setLoadingAvatar(true)
    setError(null)
    try {
      const { data, mime } = await fetchImageAsBase64(url)
      setImageData(data)
      setImageMime(mime)
      setCaption('')
    } catch (err: any) {
      setError(err?.message || `Failed to load ${kind} avatar`)
    } finally {
      setLoadingAvatar(false)
    }
  }, [activeCharacter, activePersona])

  const generate = async () => {
    if (!imageData) return
    setBusy(true)
    setError(null)
    setCopied(false)
    try {
      const preset = selectedPresetId
        ? captioningPresets.find((p) => p.id === selectedPresetId)
        : null
      const res = await imageGenApi.caption({
        image: imageData,
        mimeType: imageMime,
        prompt: prompt.trim() || preset?.prompt || undefined,
        presetId: selectedPresetId,
        parserConnectionId: preset?.parserConnectionId,
        parserModel: preset?.parserModel,
        parserParameters: preset?.parserParameters,
      })
      setCaption(res.caption)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Captioning failed')
    } finally {
      setBusy(false)
    }
  }

  const doCopy = async () => {
    if (!caption) return
    await copyTextToClipboard(caption)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  if (!isOpen) return null

  return (
    <ModalShell isOpen={isOpen} onClose={closeModal} maxWidth={560} maxHeight="90vh" className={styles.modal}>
      <div className={styles.header}>
        <h3 className={styles.title}>Image Captioner</h3>
        <p className={styles.subtitle}>
          Upload an image and generate descriptive tags or captions using your parser model.
        </p>
      </div>

      <div className={styles.body}>
        {/* Image upload / drop zone */}
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Image</label>
          <div
            className={`${styles.dropZone} ${dragOver ? styles.dropZoneActive : ''}`}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {imageData ? (
              <>
                <img
                  src={`data:${imageMime};base64,${imageData}`}
                  alt="Preview"
                  className={styles.preview}
                />
                <button
                  type="button"
                  className={styles.clearBtn}
                  onClick={(e) => { e.stopPropagation(); setImageData(null); setCaption('') }}
                  title="Remove image"
                >
                  &times;
                </button>
              </>
            ) : (
              <span className={styles.dropZoneHint}>
                {loadingAvatar ? 'Loading avatar...' : 'Drop an image here, click to browse, or paste from clipboard'}
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_TYPES.join(',')}
              className={styles.hiddenInput}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) loadFile(file)
                e.target.value = ''
              }}
            />
          </div>
          {(hasCharacterAvatar || hasPersonaAvatar) && !imageData && (
            <div className={styles.avatarRow}>
              {hasCharacterAvatar && (
                <button
                  type="button"
                  className={styles.avatarBtn}
                  onClick={() => loadAvatar('character')}
                  disabled={loadingAvatar}
                >
                  Use {activeCharacter?.name || 'Character'} Avatar
                </button>
              )}
              {hasPersonaAvatar && (
                <button
                  type="button"
                  className={styles.avatarBtn}
                  onClick={() => loadAvatar('persona')}
                  disabled={loadingAvatar}
                >
                  Use {activePersona?.name || 'Persona'} Avatar
                </button>
              )}
            </div>
          )}
        </div>

        {/* Prompt */}
        <div className={styles.fieldGroup}>
          <label className={styles.label}>Prompt</label>
          {captioningPresets.length > 0 && (
            <div className={styles.presetRow}>
              <select
                className={styles.presetSelect}
                value={selectedPresetId || ''}
                onChange={(e) => {
                  const id = e.target.value || null
                  setSelectedPresetId(id)
                  if (id) {
                    const p = captioningPresets.find((pr) => pr.id === id)
                    if (p) setPrompt(p.prompt)
                  }
                }}
              >
                <option value="">No preset</option>
                {captioningPresets.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}
          <textarea
            className={styles.textarea}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe this image in detail using concise image-generation tags..."
            rows={3}
          />
        </div>

        {/* Output */}
        {(caption || busy) && (
          <div className={styles.fieldGroup}>
            <label className={styles.label}>Caption</label>
            <div className={styles.outputWrap}>
              <textarea
                className={styles.outputArea}
                value={busy ? 'Generating caption...' : caption}
                onChange={(e) => setCaption(e.target.value)}
                readOnly={busy}
                rows={4}
              />
              {caption && !busy && (
                <button type="button" className={styles.copyBtn} onClick={doCopy}>
                  {copied ? 'Copied!' : 'Copy'}
                </button>
              )}
            </div>
          </div>
        )}

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button type="button" className={`${styles.btn} ${styles.btnCancel}`} onClick={closeModal} disabled={busy}>
            Close
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSubmit}`}
            onClick={generate}
            disabled={busy || !imageData}
          >
            {busy ? 'Captioning...' : caption ? 'Re-caption' : 'Generate Caption'}
          </button>
        </div>
      </div>
    </ModalShell>
  )
}
