import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { Toggle } from '@/components/shared/Toggle'
import { presetsApi } from '@/api/presets'
import { regexApi } from '@/api/regex'
import type { Preset } from '@/types/api'
import type { RegexPromptActivation, RegexPromptActivationMapping } from '@/types/regex'
import { formatActivationValues, parseActivationValues } from '@/lib/regex/activation-values'
import styles from './RegexEditorModal.module.css'

interface Props {
  presetId: string | null
  value: RegexPromptActivation | null
  onChange: (value: RegexPromptActivation | null) => void
  findRegex: string
  flags: string
  testInput: string
  onExample: (source: RegexPromptActivation['source']) => void
  onInsertFindInput?: (token: string) => void
  onResolvedFindPattern?: (pattern: string | null) => void
  chatId?: string
  characterId?: string
  personaId?: string
  connectionId?: string
}

function ActivationValuesInput({ value, onChange }: {
  value: RegexPromptActivationMapping['value']
  onChange: (value: RegexPromptActivationMapping['value']) => void
}) {
  const { t } = useTranslation('modals', { keyPrefix: 'regexEditor.activation' })
  const hintId = useId()
  const [draft, setDraft] = useState(() => formatActivationValues(value))
  const [invalid, setInvalid] = useState(false)
  const lastValue = useRef(JSON.stringify(value))
  const serialized = JSON.stringify(value)
  useEffect(() => {
    if (lastValue.current === serialized) return
    lastValue.current = serialized
    setDraft(formatActivationValues(value))
    setInvalid(false)
  }, [serialized, value])
  return <label className={styles.field}>
    <span className={styles.fieldLabel}>{t('value')}</span>
    <textarea className={`${styles.fieldInput} ${styles.activationValues}`} rows={2}
      value={draft} placeholder="combat, fight, battle" aria-describedby={hintId} aria-invalid={invalid}
      onChange={(event) => {
        const text = event.target.value
        setDraft(text)
        const parsed = parseActivationValues(text)
        setInvalid(parsed === null)
        // An invalid draft must not leave the old, valid mapping available for Save.
        const next = parsed?.length === 1 ? parsed[0] : parsed ?? []
        lastValue.current = JSON.stringify(next)
        onChange(next)
      }} />
    <span id={hintId} className={invalid ? styles.testError : styles.fieldHint}>
      {t(invalid ? 'valuesQuoteError' : 'valuesHint')}
    </span>
  </label>
}

export default function RegexPromptActivationEditor({ presetId, value, onChange, findRegex, flags, testInput, onExample,
  onInsertFindInput, onResolvedFindPattern, chatId, characterId, personaId, connectionId }: Props) {
  const { t } = useTranslation('modals', { keyPrefix: 'regexEditor.activation' })
  const [preset, setPreset] = useState<Preset | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [chatKey, setChatKey] = useState('')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof regexApi.testActivation>> | null>(null)

  useEffect(() => {
    let current = true
    setPreset(null)
    setLoadError(false)
    if (presetId) presetsApi.get(presetId).then((result) => {
      if (current) setPreset(result)
    }).catch(() => { if (current) setLoadError(true) })
    return () => { current = false }
  }, [presetId])

  useEffect(() => {
    let current = true
    setPreview(null)
    onResolvedFindPattern?.(null)
    if (!presetId || !value || !findRegex || !testInput) return
    const timer = setTimeout(() => {
      regexApi.testActivation({ preset_id: presetId, find_regex: findRegex, flags, content: testInput, prompt_activation: value,
        chat_id: chatId, character_id: characterId, persona_id: personaId, connection_id: connectionId })
        .then((result) => {
          if (current) {
            setPreview(result)
            onResolvedFindPattern?.(result.error ? null : result.resolved_find_regex ?? findRegex)
          }
        })
        .catch((error) => { if (current) setPreview({ matches: [], error: error.body?.error || error.message }) })
    }, 300)
    return () => { current = false; clearTimeout(timer) }
  }, [presetId, value, findRegex, flags, testInput, chatId, characterId, personaId, connectionId, onResolvedFindPattern])

  const blocks = (preset?.prompt_order ?? []) as Array<{ id: string; name: string; marker?: string | null; variables?: Array<{ id: string; name: string }> }>
  const updateMapping = (index: number, updates: Partial<RegexPromptActivationMapping>) => {
    if (value) onChange({ ...value, mappings: value.mappings.map((mapping, i) => i === index ? { ...mapping, ...updates } : mapping) })
  }
  const addMapping = () => {
    if (value) onChange({ ...value, mappings: [...value.mappings, { capture: '0', value: '', block_ids: [], enabled: true }] })
  }

  return <div className={styles.section}>
    <Toggle.Checkbox
      checked={!!value && !!presetId}
      disabled={!presetId}
      label={t('title')}
      onChange={(enabled) => onChange(enabled ? { source: 'user_input', lifetime: 'latest', mappings: [] } : null)}
    />
    {!presetId && <div className={styles.actionHint}>{t('unlinked')}</div>}
    {presetId && <div className={styles.actionHint}>{loadError ? t('loadError') : t('linkedPreset', { name: preset?.name ?? '…' })}</div>}
    {value && presetId && <>
      <div className={styles.actionHint}>{t('hint')}</div>
      <div className={styles.fieldLabel}>{t('inputs')}</div>
      <div className={styles.actionHint}>{t('inputsHint')}</div>
      {onInsertFindInput && <>
        <div className={styles.tokenBar}>
          {['{{char}}', '{{user}}'].map((token) => <button key={token} type="button" className={styles.tokenChip} onClick={() => onInsertFindInput(token)}>{token}</button>)}
        </div>
        <div className={styles.actionTitleRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('chatKey')}</span>
            <input className={styles.fieldInput} value={chatKey} onChange={(event) => setChatKey(event.target.value)} placeholder="desired_mode" />
          </label>
          <button type="button" className={styles.tokenChip} disabled={!chatKey.trim()} onClick={() => onInsertFindInput(`{{getchatvar::${chatKey.trim()}}}`)}>{t('insertChatKey')}</button>
        </div>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('presetInput')}</span>
          <select className={styles.fieldInput} value="" onChange={(event) => { if (event.target.value) onInsertFindInput(event.target.value) }}>
            <option value="">{t('choosePresetInput')}</option>
            {blocks.flatMap((block) => (block.variables ?? []).map((variable) => <option key={`${block.id}:${variable.id}`} value={`{{presetvar::${block.id}::${variable.id}}}`}>
              {block.name} / {variable.name}
            </option>))}
          </select>
        </label>
      </>}
      <div className={styles.actionHint}>{t(chatId ? 'contextHint' : 'noChatHint')}</div>
      <div className={styles.actionTitleRow}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('source')}</span>
          <select className={styles.fieldInput} value={value.source} onChange={(event) => onChange({ ...value, source: event.target.value as RegexPromptActivation['source'] })}>
            <option value="user_input">{t('user')}</option>
            <option value="ai_output">{t('assistant')}</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{t('lifetime')}</span>
          <select className={styles.fieldInput} value={value.lifetime} onChange={(event) => onChange({ ...value, lifetime: event.target.value as RegexPromptActivation['lifetime'] })}>
            <option value="latest">{t('latest')}</option>
            <option value="chat">{t('chat')}</option>
          </select>
        </label>
      </div>
      <div className={styles.actionHint}>{t(value.source === 'ai_output' ? 'assistantHint' : 'userHint')}</div>
      <div className={styles.tokenBar}>
        <button type="button" className={styles.tokenChip} onClick={() => onExample('user_input')}>{t('userExample')}</button>
        <button type="button" className={styles.tokenChip} onClick={() => onExample('ai_output')}>{t('assistantExample')}</button>
      </div>
      {value.mappings.map((mapping, index) => <div className={styles.actionCard} key={index}>
        <div className={`${styles.actionTitleRow} ${styles.activationMappingRow}`}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('capture')}</span>
            <input className={styles.fieldInput} value={mapping.capture} onChange={(event) => updateMapping(index, { capture: event.target.value })} placeholder="0 / 1 / mode" />
          </label>
          <ActivationValuesInput value={mapping.value} onChange={(value) => updateMapping(index, { value })} />
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{t('operation')}</span>
            <select className={styles.fieldInput} value={String(mapping.enabled)} onChange={(event) => updateMapping(index, { enabled: event.target.value === 'true' })}>
              <option value="true">{t('enable')}</option>
              <option value="false">{t('disable')}</option>
            </select>
          </label>
          <button type="button" className={styles.tokenChip} aria-label={t('remove')} onClick={() => onChange({ ...value, mappings: value.mappings.filter((_, i) => i !== index) })}><Trash2 size={14} /></button>
        </div>
        <div className={styles.fieldHint}>{t('captureHint')}</div>
        <fieldset className={styles.activationTargets}>
          <legend className={styles.fieldLabel}>{t('targets')}</legend>
          {blocks.map((block) => <label key={block.id} className={styles.activationTarget}>
            <input type="checkbox" checked={mapping.block_ids.includes(block.id)} onChange={(event) => updateMapping(index, {
              block_ids: event.target.checked ? [...mapping.block_ids, block.id] : mapping.block_ids.filter((id) => id !== block.id),
            })} />
            {block.marker === 'category' ? t('category', { name: block.name }) : block.name}
          </label>)}
          {mapping.block_ids.filter((id) => !blocks.some((block) => block.id === id)).map((id) => <label key={id} className={styles.activationTarget}>
            <input type="checkbox" checked onChange={() => updateMapping(index, { block_ids: mapping.block_ids.filter((selected) => selected !== id) })} />
            {t('missingTarget', { id })}
          </label>)}
        </fieldset>
      </div>)}
      <button type="button" className={styles.addActionButton} onClick={addMapping} disabled={value.mappings.length >= 64}><Plus size={13} /> {t('add')}</button>
      <div className={styles.actionHint}>{t('orderHint')}</div>
      <div className={styles.fieldLabel}>{t('preview')}</div>
      {!preview && <div className={styles.actionHint}>{t('previewHint')}</div>}
      {preview?.error && <div role="alert" className={styles.testError}>{preview.error}</div>}
      {preview?.resolved_find_regex && <details><summary>{t('resolvedPattern')}</summary><pre className={styles.testOutput}>{preview.resolved_find_regex}</pre></details>}
      {preview && !preview.error && preview.matches.length === 0 && <div className={styles.actionHint}>{t('noMatch')}</div>}
      {preview?.matches.map((match, index) => {
        const mapping = value.mappings[match.mapping_index]
        if (!mapping) return null
        return <div className={styles.testOutput} key={index}>{t('matched', {
          value: match.value, operation: t(mapping.enabled ? 'enable' : 'disable'),
          targets: mapping.block_ids.map((id) => {
            const block = blocks.find((block) => block.id === id)
            return block?.marker === 'category' ? t('category', { name: block.name }) : block?.name ?? id
          }).join(', '),
        })}</div>
      })}
    </>}
  </div>
}
