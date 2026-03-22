import { useState, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Plus, Trash2, Wrench, Code, Settings } from 'lucide-react'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput, TextArea, Select, EditorSection } from '@/components/shared/FormComponents'
import ConfirmationModal from '@/components/shared/ConfirmationModal'
import type { LoomTool, CreateLoomToolInput } from '@/types/api'
import clsx from 'clsx'
import styles from './ToolEditorModal.module.css'

interface SchemaProperty {
  name: string
  type: string
  description: string
}

const TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'integer', label: 'Integer' },
]

function parseSchemaProps(schema: Record<string, any>): SchemaProperty[] {
  const props = schema?.properties
  if (!props || typeof props !== 'object') return []
  return Object.entries(props).map(([name, def]: [string, any]) => ({
    name,
    type: def?.type || 'string',
    description: def?.description || '',
  }))
}

function buildSchema(properties: SchemaProperty[]): Record<string, any> {
  if (properties.length === 0) return {}
  const props: Record<string, any> = {}
  const required: string[] = []
  for (const p of properties) {
    if (!p.name.trim()) continue
    props[p.name.trim()] = { type: p.type, description: p.description }
    required.push(p.name.trim())
  }
  return { type: 'object', properties: props, required }
}

export default function ToolEditorModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)

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
    setSchemaProps([...schemaProps, { name: '', type: 'string', description: '' }])
  }

  const updateProperty = (index: number, field: keyof SchemaProperty, value: string) => {
    const updated = [...schemaProps]
    updated[index] = { ...updated[index], [field]: value }
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
      onSaved?.()
      closeModal()
    } catch (err) {
      console.error('Failed to save tool:', err)
    } finally {
      setSaving(false)
    }
  }

  const canSave = toolName.trim() && displayName.trim() && prompt.trim()

  return createPortal(
    <>
      <div className={styles.overlay} onClick={(e) => e.target === e.currentTarget && handleClose()}>
        <div className={styles.modal}>
          <div className={styles.header}>
            <h3 className={styles.title}>{editingItem ? 'Edit Tool' : 'Create Tool'}</h3>
            <button type="button" className={styles.closeBtn} onClick={handleClose}>
              <X size={16} />
            </button>
          </div>

          <div className={styles.body}>
            <EditorSection Icon={Wrench} title="Tool Details">
              <div className={styles.row}>
                <div className={styles.rowHalf}>
                  <FormField label="Tool Name" required hint="Internal identifier (snake_case)">
                    <TextInput value={toolName} onChange={setToolName} placeholder="my_tool" autoFocus />
                  </FormField>
                </div>
                <div className={styles.rowHalf}>
                  <FormField label="Display Name" required>
                    <TextInput value={displayName} onChange={setDisplayName} placeholder="My Tool" />
                  </FormField>
                </div>
              </div>

              <FormField label="Description">
                <TextInput value={description} onChange={setDescription} placeholder="What this tool does..." />
              </FormField>

              <FormField label="Author">
                <TextInput value={authorName} onChange={setAuthorName} placeholder="Author name" />
              </FormField>
            </EditorSection>

            <EditorSection Icon={Code} title="Tool Prompt">
              <FormField label="Prompt" required hint="Instructions the AI receives when using this tool">
                <TextArea value={prompt} onChange={setPrompt} placeholder="You are a tool that..." rows={5} />
              </FormField>
            </EditorSection>

            <EditorSection Icon={Settings} title="Input Schema" defaultExpanded={schemaProps.length > 0}>
              {schemaProps.map((prop, i) => (
                <div key={i} className={styles.schemaRow}>
                  <div className={styles.schemaFields}>
                    <div className={styles.schemaFieldRow}>
                      <TextInput value={prop.name} onChange={(v) => updateProperty(i, 'name', v)} placeholder="Property name" />
                      <Select value={prop.type} onChange={(v) => updateProperty(i, 'type', v)} options={TYPE_OPTIONS} />
                    </div>
                    <TextInput value={prop.description} onChange={(v) => updateProperty(i, 'description', v)} placeholder="Description" />
                  </div>
                  <button type="button" className={styles.schemaRemoveBtn} onClick={() => removeProperty(i)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button type="button" className={styles.addPropertyBtn} onClick={addProperty}>
                <Plus size={14} /> Add Property
              </button>
            </EditorSection>

            <EditorSection Icon={Settings} title="Result Routing" defaultExpanded={false}>
              <FormField label="Result Variable" hint="Variable name to store the tool's output">
                <TextInput value={resultVariable} onChange={setResultVariable} placeholder="result_var" />
              </FormField>

              <div className={styles.toggleRow}>
                <span className={styles.toggleLabel}>Store in deliberation</span>
                <button
                  type="button"
                  className={clsx(styles.toggle, storeInDeliberation && styles.toggleActive)}
                  onClick={() => setStoreInDeliberation(!storeInDeliberation)}
                >
                  <span className={styles.toggleKnob} />
                </button>
              </div>
            </EditorSection>
          </div>

          <div className={styles.footer}>
            <button type="button" className={styles.btnCancel} onClick={handleClose}>Cancel</button>
            <button type="button" className={styles.btnSave} onClick={handleSave} disabled={!canSave || saving}>
              {saving ? 'Saving...' : editingItem ? 'Save Changes' : 'Create'}
            </button>
          </div>
        </div>
      </div>

      {showDiscard && (
        <ConfirmationModal
          isOpen
          title="Discard changes?"
          message="You have unsaved changes. Are you sure you want to discard them?"
          variant="warning"
          confirmText="Discard"
          cancelText="Keep editing"
          onConfirm={() => {
            setShowDiscard(false)
            closeModal()
          }}
          onCancel={() => setShowDiscard(false)}
          zIndex={10003}
        />
      )}
    </>,
    document.body
  )
}
