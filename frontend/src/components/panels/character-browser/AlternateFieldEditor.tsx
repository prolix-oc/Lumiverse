import { useState, useCallback, useRef, useEffect } from 'react'
import { Plus, X, Pencil, Check } from 'lucide-react'
import { ExpandableTextarea } from '@/components/shared/ExpandedTextEditor'
import { uuidv7 } from '@/lib/uuid'
import styles from './AlternateFieldEditor.module.css'
import editorStyles from './CharacterEditorPage.module.css'

export interface AlternateFieldVariant {
  id: string
  label: string
  content: string
}

interface Props {
  label: string
  helper: string
  /** The character's base field value (always the "Default"). */
  value: string
  /** Alternate variants from character.extensions.alternate_fields[field]. */
  alternates?: AlternateFieldVariant[]
  /** Called when the base field value changes (editing Default variant). */
  onChange: (value: string) => void
  /** Called when the alternate variants array changes. */
  onAlternatesChange: (variants: AlternateFieldVariant[]) => void
  rows?: number
}

export default function AlternateFieldEditor({
  label,
  helper,
  value,
  alternates,
  onChange,
  onAlternatesChange,
  rows = 4,
}: Props) {
  const hasAlternates = alternates && alternates.length > 0
  const [activeVariantId, setActiveVariantId] = useState<string | null>(null) // null = default
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)

  // Focus rename input
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renamingId])

  const activeVariant = activeVariantId
    ? alternates?.find((v) => v.id === activeVariantId) ?? null
    : null

  // Maintain local content state for variants so the textarea doesn't read
  // stale store data between debounced saves (which caused cursor jumps).
  const [localVariantContent, setLocalVariantContent] = useState('')
  const prevVariantIdRef = useRef<string | null>(null)

  // Re-sync local content when the active variant switches
  if (activeVariantId !== prevVariantIdRef.current) {
    prevVariantIdRef.current = activeVariantId
    setLocalVariantContent(activeVariant?.content ?? '')
  }

  const activeContent = activeVariantId ? localVariantContent : value

  const handleContentChange = useCallback(
    (newContent: string) => {
      if (activeVariantId && alternates) {
        setLocalVariantContent(newContent)
        const updated = alternates.map((v) =>
          v.id === activeVariantId ? { ...v, content: newContent } : v
        )
        onAlternatesChange(updated)
      } else {
        // Editing the default — parent maintains local state via setFields()
        onChange(newContent)
      }
    },
    [activeVariantId, alternates, onChange, onAlternatesChange]
  )

  const handleAddVariant = useCallback(() => {
    const newVariant: AlternateFieldVariant = {
      id: uuidv7(),
      label: `Variant ${(alternates?.length ?? 0) + 1}`,
      content: '',
    }
    const updated = [...(alternates || []), newVariant]
    onAlternatesChange(updated)
    setActiveVariantId(newVariant.id)
  }, [alternates, onAlternatesChange])

  const handleDeleteVariant = useCallback(
    (variantId: string) => {
      if (!alternates) return
      const updated = alternates.filter((v) => v.id !== variantId)
      onAlternatesChange(updated)
      if (activeVariantId === variantId) {
        setActiveVariantId(null)
      }
    },
    [alternates, activeVariantId, onAlternatesChange]
  )

  const handleStartRename = useCallback((variant: AlternateFieldVariant) => {
    setRenamingId(variant.id)
    setRenameValue(variant.label)
  }, [])

  const handleFinishRename = useCallback(() => {
    if (!renamingId || !alternates) return
    const trimmed = renameValue.trim()
    if (trimmed) {
      const updated = alternates.map((v) =>
        v.id === renamingId ? { ...v, label: trimmed } : v
      )
      onAlternatesChange(updated)
    }
    setRenamingId(null)
  }, [renamingId, renameValue, alternates, onAlternatesChange])

  // No alternates: render like original Field, with an "Add variant" link
  if (!hasAlternates) {
    return (
      <div className={editorStyles.fieldGroup}>
        <div className={styles.labelRow}>
          <span className={editorStyles.fieldLabel}>{label}</span>
          <button type="button" className={styles.addVariantLink} onClick={handleAddVariant}>
            <Plus size={11} />
            Add variant
          </button>
        </div>
        <span className={editorStyles.fieldHelper}>{helper}</span>
        <ExpandableTextarea
          className={editorStyles.fieldTextarea}
          value={value}
          onChange={onChange}
          rows={rows}
          title={label}
          placeholder={`${label}...`}
        />
      </div>
    )
  }

  return (
    <div className={editorStyles.fieldGroup}>
      <div className={styles.labelRow}>
        <span className={editorStyles.fieldLabel}>{label}</span>
        <span className={editorStyles.fieldHelper}>{helper}</span>
      </div>

      {/* Variant tabs */}
      <div className={styles.variantBar}>
        <button
          type="button"
          className={`${styles.variantTab} ${!activeVariantId ? styles.variantTabActive : ''}`}
          onClick={() => setActiveVariantId(null)}
        >
          Default
        </button>
        {alternates!.map((variant) => (
          <div key={variant.id} className={styles.variantTabWrapper}>
            {renamingId === variant.id ? (
              <div className={styles.renameWrapper}>
                <input
                  ref={renameInputRef}
                  className={styles.renameInput}
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={handleFinishRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleFinishRename()
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                />
                <button type="button" className={styles.renameConfirm} onClick={handleFinishRename}>
                  <Check size={10} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className={`${styles.variantTab} ${activeVariantId === variant.id ? styles.variantTabActive : ''}`}
                onClick={() => setActiveVariantId(variant.id)}
              >
                {variant.label}
              </button>
            )}
            {activeVariantId === variant.id && renamingId !== variant.id && (
              <div className={styles.variantActions}>
                <button type="button" onClick={() => handleStartRename(variant)} title="Rename">
                  <Pencil size={10} />
                </button>
                <button type="button" onClick={() => handleDeleteVariant(variant.id)} title="Delete variant">
                  <X size={10} />
                </button>
              </div>
            )}
          </div>
        ))}
        <button type="button" className={styles.addVariantBtn} onClick={handleAddVariant} title="Add variant">
          <Plus size={12} />
        </button>
      </div>

      {/* Active variant textarea */}
      <ExpandableTextarea
        className={editorStyles.fieldTextarea}
        value={activeContent}
        onChange={handleContentChange}
        rows={rows}
        title={activeVariant ? `${label} — ${activeVariant.label}` : label}
        placeholder={`${label}...`}
      />
    </div>
  )
}
