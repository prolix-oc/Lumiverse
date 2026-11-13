import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Plus, Trash2, Wrench, Code, Settings } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput, TextArea, Select, EditorSection, Button } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { LoomTool, CreateLoomToolInput } from '@/types/api'
import clsx from 'clsx'
import styles from './ToolEditorModal.module.css'

interface SchemaProperty {
  name: string
  type: string
  description: string
  required: boolean
}

function parseSchemaProps(schema: Record<string, any>): SchemaProperty[] {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return []
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  return Object.entries(props).map(([name, def]: [string, any]) => ({
    name,
    type: def?.type || 'string',
    description: def?.description || '',
    required: required.has(name),
  }))
}

function buildSchema(properties: SchemaProperty[]): Record<string, any> {
  if (properties.length === 0) return {}
  const props: Record<string, any> = {}
  const required: string[] = []
  for (const p of properties) {
    if (!p.name.trim()) continue
    props[p.name.trim()] = { type: p.type, description: p.description }
    if (p.required) required.push(p.name.trim())
  }
  return { type: 'object', properties: props, ...(required.length > 0 ? { required } : {}) }
}

function buildPromptGuide(properties: SchemaProperty[], t: TFunction<'panels'>): string {
  const activeProps = properties.filter((prop) => prop.name.trim())
  if (activeProps.length === 0) {
    return [
      t('creatorWorkshop.toolEditor.promptGuideEmpty'),
      t('creatorWorkshop.toolEditor.promptGuideFreeform'),
    ].join('\n')
  }

  const lines = [
    t('creatorWorkshop.toolEditor.promptGuideIntro'),
    '',
    t('creatorWorkshop.toolEditor.promptGuideReturn'),
  ]

  for (const prop of activeProps) {
    const status = prop.required
      ? t('creatorWorkshop.shared.required')
      : t('creatorWorkshop.shared.optional')
    const description = prop.description.trim()
      ? `: ${prop.description.trim()}`
      : ''
    lines.push(t('creatorWorkshop.toolEditor.promptGuideField', {
      name: prop.name.trim(),
      type: prop.type,
      status,
      description,
    }))
  }

  lines.push(t('creatorWorkshop.toolEditor.promptGuideFooter'))
  return lines.join('\n')
}

const LOOM_COUNCIL_MACRO = '{{loomCouncilResult::your_variable}}'

export default function ToolEditorModal() {
  const { t } = useTranslation('panels')
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const loadAvailableTools = useStore((s) => s.loadAvailableTools)

  const typeOptions = useMemo(() => [
    { value: 'string', label: t('creatorWorkshop.shared.schemaType.string') },
    { value: 'number', label: t('creatorWorkshop.shared.schemaType.number') },
    { value: 'boolean', label: t('creatorWorkshop.shared.schemaType.boolean') },
    { value: 'integer', label: t('creatorWorkshop.shared.schemaType.integer') },
  ], [t])

  const packId = modalProps.packId as string
  const editingItem = modalProps.editingItem as LoomTool | undefined
  const onSaved = modalProps.onSaved as (() => void) | undefined

  const [toolName, setToolName] = useState(editingItem?.tool_name || '')
  const [displayName, setDisplayName] = useState(editingItem?.display_name || '')
  const [description, setDescription] = useState(editingItem?.description || '')
  const [authorName, setAuthorName] = useState(editingItem?.author_name || '')
  const [prompt, setPrompt] = useState(editingItem?.prompt || '')
  const [schemaProps, setSchemaProps] = useState<SchemaProperty[]>(
    editingItem ? parseSchemaProps(editingItem.input_schema) : []
  )
  const [resultVariable, setResultVariable] = useState(editingItem?.result_variable || '')
  const [storeInDeliberation, setStoreInDeliberation] = useState(editingItem?.store_in_deliberation ?? false)
  const [saving, setSaving] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)

  const initialRef = useRef(JSON.stringify({
    toolName: editingItem?.tool_name || '',
    displayName: editingItem?.display_name || '',
    description: editingItem?.description || '',
    authorName: editingItem?.author_name || '',
    prompt: editingItem?.prompt || '',
    schemaProps: editingItem ? parseSchemaProps(editingItem.input_schema) : [],
    resultVariable: editingItem?.result_variable || '',
    storeInDeliberation: editingItem?.store_in_deliberation ?? false,
  }))

  const isDirty = useCallback(() => {
    const current = JSON.stringify({
      toolName, displayName, description, authorName, prompt,
      schemaProps, resultVariable, storeInDeliberation,
    })
    return current !== initialRef.current
  }, [toolName, displayName, description, authorName, prompt, schemaProps, resultVariable, storeInDeliberation])

  const handleClose = useCallback(() => {
    if (isDirty()) {
      setShowDiscard(true)
    } else {
      closeModal()
    }
  }, [isDirty, closeModal])

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    document.addEventListener('keydown', handleEsc)
    return () => document.removeEventListener('keydown', handleEsc)
  }, [handleClose])

  const addProperty = () => {
    setSchemaProps([...schemaProps, { name: '', type: 'string', description: '', required: true }])
  }

  const updateProperty = (index: number, field: keyof SchemaProperty, value: string | boolean) => {
    const updated = [...schemaProps]
    updated[index] = { ...updated[index], [field]: value } as SchemaProperty
    setSchemaProps(updated)
  }

  const removeProperty = (index: number) => {
    setSchemaProps(schemaProps.filter((_, i) => i !== index))
  }

  const handleSave = async () => {
    if (!toolName.trim() || !displayName.trim() || !prompt.trim() || saving) return
    setSaving(true)
    try {
      const data: CreateLoomToolInput = {
        tool_name: toolName.trim(),
        display_name: displayName.trim(),
        description: description.trim() || undefined,
        author_name: authorName.trim() || undefined,
        prompt: prompt.trim(),
        input_schema: buildSchema(schemaProps),
        result_variable: resultVariable.trim() || undefined,
        store_in_deliberation: storeInDeliberation,
      }
      if (editingItem) {
        await packsApi.updateLoomTool(packId, editingItem.id, data)
      } else {
        await packsApi.createLoomTool(packId, data)
      }
      void loadAvailableTools()
      onSaved?.()
      closeModal()
    } catch (err) {
      console.error('Failed to save tool:', err)
    } finally {
      setSaving(false)
    }
  }

  const generatedSchema = buildSchema(schemaProps)
  const schemaPreview = Object.keys(generatedSchema).length > 0
    ? JSON.stringify(generatedSchema, null, 2)
    : '{}'
  const canSave = toolName.trim() && displayName.trim() && prompt.trim()

  return (
    <>
      <ModalShell isOpen onClose={handleClose} maxWidth={720} maxHeight="90vh" closeOnEscape={false} className={styles.modal}>
        <div className={styles.header}>
          <h3 className={styles.title}>
            {editingItem ? t('creatorWorkshop.toolEditor.editTitle') : t('creatorWorkshop.toolEditor.createTitle')}
          </h3>
          <CloseButton onClick={handleClose} />
        </div>

        <div className={styles.body}>
          <div className={styles.helpCard}>
            <div className={styles.helpTitle}>{t('creatorWorkshop.toolEditor.helpTitle')}</div>
            <div className={styles.helpText}>{t('creatorWorkshop.toolEditor.helpText')}</div>
            <div className={styles.helpList}>
              <div>{t('creatorWorkshop.toolEditor.helpStep1')}</div>
              <div>{t('creatorWorkshop.toolEditor.helpStep2')}</div>
              <div>{t('creatorWorkshop.toolEditor.helpStep3', { macroExample: LOOM_COUNCIL_MACRO })}</div>
            </div>
          </div>

          <EditorSection Icon={Wrench} title={t('creatorWorkshop.toolEditor.toolDetails')}>
            <div className={styles.row}>
              <div className={styles.rowHalf}>
                <FormField label={t('creatorWorkshop.toolEditor.toolName')} required hint={t('creatorWorkshop.toolEditor.toolNameHint')}>
                  <TextInput value={toolName} onChange={setToolName} placeholder={t('creatorWorkshop.toolEditor.toolNamePlaceholder')} autoFocus />
                </FormField>
              </div>
              <div className={styles.rowHalf}>
                <FormField label={t('creatorWorkshop.toolEditor.displayName')} required hint={t('creatorWorkshop.toolEditor.displayNameHint')}>
                  <TextInput value={displayName} onChange={setDisplayName} placeholder={t('creatorWorkshop.toolEditor.displayNamePlaceholder')} />
                </FormField>
              </div>
            </div>

            <FormField label={t('creatorWorkshop.toolEditor.description')} hint={t('creatorWorkshop.toolEditor.descriptionHint')}>
              <TextInput value={description} onChange={setDescription} placeholder={t('creatorWorkshop.toolEditor.descriptionPlaceholder')} />
            </FormField>

            <FormField label={t('creatorWorkshop.shared.author')}>
              <TextInput value={authorName} onChange={setAuthorName} placeholder={t('creatorWorkshop.loomEditor.authorPlaceholder')} />
            </FormField>
          </EditorSection>

          <EditorSection Icon={Code} title={t('creatorWorkshop.toolEditor.toolPrompt')}>
            <FormField label={t('creatorWorkshop.toolEditor.prompt')} required hint={t('creatorWorkshop.toolEditor.promptHint')}>
              <TextArea value={prompt} onChange={setPrompt} placeholder={t('creatorWorkshop.toolEditor.promptPlaceholder')} rows={6} />
            </FormField>

            <div className={styles.subtleCard}>
              <div className={styles.subtleCardTitle}>{t('creatorWorkshop.toolEditor.promptHelperTitle')}</div>
              <div className={styles.subtleCardText}>{t('creatorWorkshop.toolEditor.promptHelperText')}</div>
              <pre className={styles.codeBlock}>{buildPromptGuide(schemaProps, t)}</pre>
            </div>
          </EditorSection>

          <EditorSection Icon={Settings} title={t('creatorWorkshop.toolEditor.structuredOutput')} defaultExpanded={schemaProps.length > 0}>
            <div className={styles.subtleCard}>
              <div className={styles.subtleCardTitle}>{t('creatorWorkshop.toolEditor.structuredWhatTitle')}</div>
              <div className={styles.subtleCardText}>{t('creatorWorkshop.toolEditor.structuredWhatText')}</div>
            </div>

            {schemaProps.map((prop, i) => (
              <div key={i} className={styles.schemaRow}>
                <div className={styles.schemaFields}>
                  <div className={styles.schemaFieldRow}>
                    <TextInput value={prop.name} onChange={(v) => updateProperty(i, 'name', v)} placeholder={t('creatorWorkshop.toolEditor.fieldNamePlaceholder')} />
                    <Select value={prop.type} onChange={(v) => updateProperty(i, 'type', v)} options={typeOptions} />
                  </div>
                  <TextInput value={prop.description} onChange={(v) => updateProperty(i, 'description', v)} placeholder={t('creatorWorkshop.toolEditor.fieldDescPlaceholder')} />
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={prop.required}
                      onChange={(e) => updateProperty(i, 'required', e.target.checked)}
                    />
                    {t('creatorWorkshop.toolEditor.requiredField')}
                  </label>
                </div>
                <button type="button" className={styles.schemaRemoveBtn} onClick={() => removeProperty(i)}>
                  <Trash2 size={14} />
                  </button>
              </div>
            ))}
            <button type="button" className={styles.addPropertyBtn} onClick={addProperty}>
              <Plus size={14} /> {t('creatorWorkshop.toolEditor.addField')}
            </button>

            <div className={styles.previewBlock}>
              <div className={styles.previewTitle}>{t('creatorWorkshop.toolEditor.schemaPreview')}</div>
              <pre className={styles.codeBlock}>{schemaPreview}</pre>
            </div>
          </EditorSection>

          <EditorSection Icon={Settings} title={t('creatorWorkshop.toolEditor.resultRouting')} defaultExpanded={false}>
            <div className={styles.subtleCard}>
              <div className={styles.subtleCardTitle}>{t('creatorWorkshop.toolEditor.resultRoutingTitle')}</div>
              <div className={styles.subtleCardText}>
                {t('creatorWorkshop.toolEditor.resultRoutingText', { macroExample: LOOM_COUNCIL_MACRO })}
              </div>
            </div>

            <FormField label={t('creatorWorkshop.toolEditor.resultVariable')} hint={t('creatorWorkshop.toolEditor.resultVariableHint')}>
              <TextInput value={resultVariable} onChange={setResultVariable} placeholder={t('creatorWorkshop.toolEditor.resultVariablePlaceholder')} />
            </FormField>

            <div className={styles.toggleRow}>
              <span className={styles.toggleLabel}>{t('creatorWorkshop.toolEditor.storeInDeliberation')}</span>
              <button
                type="button"
                className={clsx(styles.toggle, storeInDeliberation && styles.toggleActive)}
                onClick={() => setStoreInDeliberation(!storeInDeliberation)}
              >
                <span className={styles.toggleKnob} />
              </button>
            </div>
            <div className={styles.inlineHint}>{t('creatorWorkshop.toolEditor.storeInDeliberationHint')}</div>
          </EditorSection>
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={handleClose}>{t('creatorWorkshop.shared.cancel')}</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave || saving}>
            {saving
              ? t('creatorWorkshop.shared.saving')
              : editingItem
                ? t('creatorWorkshop.shared.saveChanges')
                : t('creatorWorkshop.shared.create')}
          </Button>
        </div>
      </ModalShell>

      {showDiscard && (
        <ConfirmationModal
          isOpen
          title={t('creatorWorkshop.shared.discardTitle')}
          message={t('creatorWorkshop.shared.discardMessage')}
          variant="warning"
          confirmText={t('creatorWorkshop.shared.discard')}
          cancelText={t('creatorWorkshop.shared.keepEditing')}
          onConfirm={() => {
            setShowDiscard(false)
            closeModal()
          }}
          onCancel={() => setShowDiscard(false)}
          zIndex={10003}
        />
      )}
    </>
  )
}
