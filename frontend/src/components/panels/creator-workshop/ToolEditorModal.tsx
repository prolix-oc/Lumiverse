import { useState, useCallback, useRef, useEffect } from 'react'
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

const TYPE_OPTIONS = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'integer', label: 'Integer' },
]

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

function buildPromptGuide(properties: SchemaProperty[]): string {
  const activeProps = properties.filter((prop) => prop.name.trim())
  if (activeProps.length === 0) {
    return [
      'No structured fields configured.',
      'Leave this section empty if you want a freeform council response.',
    ].join('\n')
  }

  const lines = [
    'Suggested instruction to add to your prompt:',
    '',
    'Return a concise response using these fields:',
  ]

  for (const prop of activeProps) {
    const status = prop.required ? 'required' : 'optional'
    const description = prop.description.trim() ? `: ${prop.description.trim()}` : ''
    lines.push(`- ${prop.name.trim()} (${prop.type}, ${status})${description}`)
  }

  lines.push('Keep each field direct and easy for the council to use.')
  return lines.join('\n')
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
          <h3 className={styles.title}>{editingItem ? 'Edit Council Tool' : 'Create Council Tool'}</h3>
          <CloseButton onClick={handleClose} />
        </div>

        <div className={styles.body}>
          <div className={styles.helpCard}>
            <div className={styles.helpTitle}>How custom council tools work</div>
            <div className={styles.helpText}>
              Pack tools send a focused prompt to the sidecar during council deliberation. The prompt is the main instruction. Structured fields are optional, and help you define the sections or values you want the tool to return.
            </div>
            <div className={styles.helpList}>
              <div>1. Write the prompt like instructions for a specialist council member.</div>
              <div>2. Add structured fields only if you want a repeatable response shape.</div>
              <div>3. Use a result variable if you want the raw result in <code>{'{{loomCouncilResult::your_variable}}'}</code>.</div>
            </div>
          </div>

          <EditorSection Icon={Wrench} title="Tool Details">
            <div className={styles.row}>
              <div className={styles.rowHalf}>
                <FormField label="Tool Name" required hint="Internal identifier, usually unique within the pack. Use snake_case.">
                  <TextInput value={toolName} onChange={setToolName} placeholder="my_tool" autoFocus />
                </FormField>
              </div>
              <div className={styles.rowHalf}>
                <FormField label="Display Name" required hint="The label council editors will see.">
                  <TextInput value={displayName} onChange={setDisplayName} placeholder="My Tool" />
                </FormField>
              </div>
            </div>

            <FormField label="Description" hint="Explain when this tool should be used and what kind of guidance it gives.">
              <TextInput value={description} onChange={setDescription} placeholder="What this tool does..." />
            </FormField>

            <FormField label="Author">
              <TextInput value={authorName} onChange={setAuthorName} placeholder="Author name" />
            </FormField>
          </EditorSection>

          <EditorSection Icon={Code} title="Tool Prompt">
            <FormField label="Prompt" required hint="This is the main instruction the council member follows. Be explicit about scope, tone, and what the final answer should contain.">
              <TextArea value={prompt} onChange={setPrompt} placeholder="You are a council specialist who reviews the latest story context and returns concise, actionable guidance..." rows={6} />
            </FormField>

            <div className={styles.subtleCard}>
              <div className={styles.subtleCardTitle}>Prompt helper</div>
              <div className={styles.subtleCardText}>
                For pack-created council tools, the fields below do not replace your prompt. If you want a structured response, tell the model to return those fields explicitly.
              </div>
              <pre className={styles.codeBlock}>{buildPromptGuide(schemaProps)}</pre>
            </div>
          </EditorSection>

          <EditorSection Icon={Settings} title="Structured Output Fields" defaultExpanded={schemaProps.length > 0}>
            <div className={styles.subtleCard}>
              <div className={styles.subtleCardTitle}>What this means</div>
              <div className={styles.subtleCardText}>
                Add fields for the pieces of information you want back from the tool. Use `string` for most text, `boolean` for yes or no, `integer` for whole numbers, and `number` for decimals. Leave this empty if the tool should answer in freeform prose.
              </div>
            </div>

            {schemaProps.map((prop, i) => (
              <div key={i} className={styles.schemaRow}>
                <div className={styles.schemaFields}>
                  <div className={styles.schemaFieldRow}>
                    <TextInput value={prop.name} onChange={(v) => updateProperty(i, 'name', v)} placeholder="field_name" />
                    <Select value={prop.type} onChange={(v) => updateProperty(i, 'type', v)} options={TYPE_OPTIONS} />
                  </div>
                  <TextInput value={prop.description} onChange={(v) => updateProperty(i, 'description', v)} placeholder="What should go in this field?" />
                  <label className={styles.checkboxLabel}>
                    <input
                      type="checkbox"
                      checked={prop.required}
                      onChange={(e) => updateProperty(i, 'required', e.target.checked)}
                    />
                    Required field
                  </label>
                </div>
                <button type="button" className={styles.schemaRemoveBtn} onClick={() => removeProperty(i)}>
                  <Trash2 size={14} />
                  </button>
              </div>
            ))}
            <button type="button" className={styles.addPropertyBtn} onClick={addProperty}>
              <Plus size={14} /> Add Field
            </button>

            <div className={styles.previewBlock}>
              <div className={styles.previewTitle}>Generated schema preview</div>
              <pre className={styles.codeBlock}>{schemaPreview}</pre>
            </div>
          </EditorSection>

          <EditorSection Icon={Settings} title="Result Routing" defaultExpanded={false}>
            <div className={styles.subtleCard}>
              <div className={styles.subtleCardTitle}>Where the result goes</div>
              <div className={styles.subtleCardText}>
                Store in deliberation to let the whole council read this tool's output. Add a result variable when you also want the raw output available to prompts and presets through <code>{'{{loomCouncilResult::your_variable}}'}</code>.
              </div>
            </div>

            <FormField label="Result Variable" hint="Optional. Saves the tool output under a macro-friendly name like scene_data or continuity_notes.">
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
            <div className={styles.inlineHint}>
              Turn this off for variable-only tools whose output should be consumed by macros or other logic without appearing in the shared council deliberation block.
            </div>
          </EditorSection>
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={handleClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={!canSave || saving}>
            {saving ? 'Saving...' : editingItem ? 'Save Changes' : 'Create'}
          </Button>
        </div>
      </ModalShell>

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
    </>
  )
}
