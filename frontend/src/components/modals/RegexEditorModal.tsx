import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import { Toggle } from '@/components/shared/Toggle'
import { ModalShell } from '@/components/shared/ModalShell'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
import { useFolders } from '@/hooks/useFolders'
import FolderDropdown from '@/components/shared/FolderDropdown'
import type { RegexPlacement, RegexTarget, RegexScope, RegexMacroMode } from '@/types/regex'
import styles from './RegexEditorModal.module.css'
import clsx from 'clsx'

/** Insert text at cursor position in a textarea, returning the new value */
function insertAtCursor(el: HTMLTextAreaElement | null, token: string): string {
  if (!el) return token
  const start = el.selectionStart
  const end = el.selectionEnd
  const val = el.value
  const newVal = val.slice(0, start) + token + val.slice(end)
  requestAnimationFrame(() => {
    el.focus()
    el.selectionStart = el.selectionEnd = start + token.length
  })
  return newVal
}

const REPLACE_TOKEN_DEFS = [
  { id: 'fullMatch', label: '$&', value: '$&' },
  { id: 'group1', label: '$1', value: '$1' },
  { id: 'group2', label: '$2', value: '$2' },
  { id: 'group3', label: '$3', value: '$3' },
  { id: 'deleteMatch', label: '""', value: '' },
] as const

const REPLACE_HTML_DEFS = [
  { id: 'bold', label: '<b>$1</b>' },
  { id: 'italic', label: '<i>$1</i>' },
  { id: 'span', label: '<span class="">$1</span>' },
  { id: 'mark', label: '<mark>$1</mark>' },
  { id: 'del', label: '<del>$1</del>' },
  { id: 'details', label: '<details><summary>$1</summary>$2</details>' },
] as const

const FIND_PRESET_DEFS = [
  { id: 'oocBlock', find: '\\(OOC:.*?\\)', replace: '' },
  { id: 'betweenTags', find: '<(\\w+)>(.*?)</\\1>', replace: '$2' },
  { id: 'asteriskActions', find: '\\*([^*]+)\\*', replace: '<i>$1</i>' },
  { id: 'quotedSpeech', find: '"([^"]+)"', replace: '<span class="dialogue">"$1"</span>' },
  { id: 'stripHtml', find: '<[^>]+>', replace: '' },
] as const

const REGEX_FLAG_KEYS = ['g', 'i', 'm', 's', 'u', 'v', 'd', 'y'] as const

export default function RegexEditorModal() {
  const { t: tr } = useTranslation('modals', { keyPrefix: 'regexEditor' })
  const { t: tc } = useTranslation('common')

  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const regexScripts = useStore((s) => s.regexScripts)
  const updateRegexScript = useStore((s) => s.updateRegexScript)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatId = useStore((s) => s.activeChatId)

  const findPresets = useMemo(
    () =>
      FIND_PRESET_DEFS.map((p) => ({
        ...p,
        label: tr(`findPresets.${p.id}.label`),
        desc: tr(`findPresets.${p.id}.desc`),
      })),
    [tr],
  )

  const replaceTokens = useMemo(
    () =>
      REPLACE_TOKEN_DEFS.map((t) => ({
        ...t,
        hint: tr(`replaceTokens.${t.id}.hint`),
      })),
    [tr],
  )

  const replaceHtmlPresets = useMemo(
    () =>
      REPLACE_HTML_DEFS.map((t) => ({
        ...t,
        hint: tr(`replaceHtml.${t.id}.hint`),
      })),
    [tr],
  )

  const scopeLabels = useMemo(
    (): Record<RegexScope, string> => ({
      global: tr('scopeGlobal'),
      character: tr('scopeCharacter'),
      chat: tr('scopeChat'),
    }),
    [tr],
  )

  const scriptId = modalProps?.scriptId as string
  const script = useMemo(() => regexScripts.find((s) => s.id === scriptId), [regexScripts, scriptId])

  const { folders, createFolder } = useFolders('regexScriptFolders', regexScripts)
  const replaceRef = useRef<HTMLTextAreaElement>(null)

  // Local state mirrors script for editing
  const [name, setName] = useState('')
  const [userScriptId, setUserScriptId] = useState('')
  const [findRegex, setFindRegex] = useState('')
  const [replaceString, setReplaceString] = useState('')
  const [flags, setFlags] = useState('gi')
  const [placement, setPlacement] = useState<RegexPlacement[]>(['ai_output'])
  const [target, setTarget] = useState<RegexTarget[]>(['response'])
  const [scope, setScope] = useState<RegexScope>('global')
  const [minDepth, setMinDepth] = useState<string>('')
  const [maxDepth, setMaxDepth] = useState<string>('')
  const [substituteMacros, setSubstituteMacros] = useState<RegexMacroMode>('none')
  const [trimStrings, setTrimStrings] = useState('')
  const [runOnEdit, setRunOnEdit] = useState(false)
  const [description, setDescription] = useState('')
  const [folder, setFolder] = useState('')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)

  // Live test
  const [testInput, setTestInput] = useState('')
  const [testResult, setTestResult] = useState<{ result: string; matches: number; error?: string } | null>(null)

  useEffect(() => {
    if (script) {
      setName(script.name)
      setUserScriptId(script.script_id || '')
      setFindRegex(script.find_regex)
      setReplaceString(script.replace_string)
      setFlags(script.flags)
      setPlacement([...script.placement])
      setTarget([...script.target])
      setScope(script.scope)
      setMinDepth(script.min_depth != null ? String(script.min_depth) : '')
      setMaxDepth(script.max_depth != null ? String(script.max_depth) : '')
      setSubstituteMacros(script.substitute_macros)
      setTrimStrings(script.trim_strings.join(', '))
      setRunOnEdit(script.run_on_edit)
      setDescription(script.description)
      setFolder(script.folder || '')
    }
  }, [script])

  // Live test effect
  useEffect(() => {
    if (!testInput || !findRegex) {
      setTestResult(null)
      return
    }
    const timer = setTimeout(async () => {
      try {
        const res = await regexApi.testRegex({ find_regex: findRegex, replace_string: replaceString, flags, content: testInput })
        setTestResult(res)
      } catch {
        setTestResult(null)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [testInput, findRegex, replaceString, flags])

  const handleSave = useCallback(async () => {
    if (!scriptId) return
    try {
      let scopeId: string | null = null
      if (scope === 'character') {
        scopeId = script?.scope === 'character' && script.scope_id ? script.scope_id : activeCharacterId
        if (!scopeId) {
          toast.error(tr('saveErrorCharacterScope'))
          return
        }
      } else if (scope === 'chat') {
        scopeId = script?.scope === 'chat' && script.scope_id ? script.scope_id : activeChatId
        if (!scopeId) {
          toast.error(tr('saveErrorChatScope'))
          return
        }
      }

      await updateRegexScript(scriptId, {
        name: name.trim(),
        script_id: userScriptId,
        find_regex: findRegex,
        replace_string: replaceString,
        flags,
        placement,
        target,
        scope,
        scope_id: scopeId,
        min_depth: minDepth ? parseInt(minDepth) : null,
        max_depth: maxDepth ? parseInt(maxDepth) : null,
        substitute_macros: substituteMacros,
        trim_strings: trimStrings ? trimStrings.split(',').map((s) => s.trim()).filter(Boolean) : [],
        run_on_edit: runOnEdit,
        description,
        folder,
      })
      closeModal()
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [scriptId, script, activeCharacterId, activeChatId, name, userScriptId, findRegex, replaceString, flags, placement, target, scope, minDepth, maxDepth, substituteMacros, trimStrings, runOnEdit, description, folder, updateRegexScript, closeModal])

  if (!script) return null

  const toggleFlag = (f: string) => {
    setFlags((prev) => prev.includes(f) ? prev.replace(f, '') : prev + f)
  }

  const togglePlacement = (p: RegexPlacement) => {
    setPlacement((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p])
  }

  const applyPreset = (find: string, replace: string) => {
    setFindRegex(find)
    setReplaceString(replace)
  }

  return (
    <ModalShell
      isOpen={true}
      onClose={closeModal}
      maxWidth={720}
      maxHeight="calc(88vh / var(--lumiverse-ui-scale, 1))"
      zIndex={10001}
      className={styles.modal}
    >
        <div className={styles.header}>
          <h2 className={styles.title}>{tr('editTitle')}</h2>
          <CloseButton onClick={closeModal} size="sm" />
        </div>

        <div className={styles.body}>
          {/* Identity row: Name + Folder side by side */}
          <div className={styles.identityRow}>
            <div className={clsx(styles.field, styles.fieldGrow)}>
              <label className={styles.fieldLabel}>{tr('name')}</label>
              <input className={styles.fieldInput} value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('namePlaceholder')} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                {tr('scriptId')}
                <span className={styles.fieldHint}>{tr('scriptIdHint')}</span>
              </label>
              <input
                className={clsx(styles.fieldInput, styles.monoText)}
                value={userScriptId}
                onChange={(e) => setUserScriptId(
                  e.target.value.toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '')
                )}
                placeholder={tr('findPlaceholder')}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{tr('folder')}</label>
              <FolderDropdown
                folders={folders}
                selectedFolder={folder}
                onSelect={setFolder}
                onCreateFolder={createFolder}
              />
            </div>
          </div>

          {/* Common Patterns (collapsible) */}
          <div className={styles.section}>
            <button type="button" className={styles.sectionToggle} onClick={() => setPresetsOpen(!presetsOpen)}>
              {presetsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>{tr('presets')}</span>
            </button>
            {presetsOpen && (
              <div className={styles.presetGrid}>
                {findPresets.map((p) => (
                  <button
                    key={p.id}
                    className={styles.presetCard}
                    onClick={() => applyPreset(p.find, p.replace)}
                  >
                    <span className={styles.presetName}>{p.label}</span>
                    <span className={styles.presetDesc}>{p.desc}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Find pattern + inline flags */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{tr('findReplace')}</div>
            <div className={styles.field}>
              <div className={styles.findHeader}>
                <label className={styles.fieldLabel}>
                  {tr('pattern')}
                  <span className={styles.fieldHint}>{tr('findHint')}</span>
                </label>
                <div className={styles.flagPills}>
                  {REGEX_FLAG_KEYS.map((f) => (
                    <button
                      key={f}
                      type="button"
                      className={clsx(styles.flagPill, flags.includes(f) && styles.flagPillActive)}
                      onClick={() => toggleFlag(f)}
                      title={tr(`flags.${f}`)}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              <textarea
                className={styles.monoInput}
                value={findRegex}
                onChange={(e) => setFindRegex(e.target.value)}
                placeholder={tr('regexPlaceholder')}
                rows={2}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                {tr('replaceWith')}
                <span className={styles.fieldHint}>{tr('replaceHint')}</span>
              </label>
              <div className={styles.tokenBar}>
                {replaceTokens.map((t) => (
                  <button
                    key={t.label}
                    className={styles.tokenChip}
                    title={t.hint}
                    onClick={() => setReplaceString(insertAtCursor(replaceRef.current, t.value))}
                  >
                    {t.label}
                  </button>
                ))}
                <span className={styles.tokenDivider} />
                {replaceHtmlPresets.slice(0, 4).map((t) => (
                  <button
                    key={t.id}
                    className={clsx(styles.tokenChip, styles.tokenChipHtml)}
                    title={t.hint}
                    onClick={() => setReplaceString(insertAtCursor(replaceRef.current, t.label))}
                  >
                    {t.label.replace(/\$\d/g, '...').replace(/<(\w+).*?>.*<\/\1>/, '<$1>')}
                  </button>
                ))}
              </div>
              <textarea
                ref={replaceRef}
                className={styles.monoInput}
                value={replaceString}
                onChange={(e) => setReplaceString(e.target.value)}
                placeholder={tr('replacePlaceholder')}
                rows={2}
              />
            </div>
          </div>

          {/* Targeting — compact 2-col grid */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{tr('targeting')}</div>
            <div className={styles.targetCols}>
              <div className={styles.targetCol}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{tr('pipeline')}</label>
                  <div className={styles.placementGrid}>
                    {([
                      { key: 'prompt' as const, label: tr('targetPrompt') },
                      { key: 'response' as const, label: tr('targetResponse') },
                      { key: 'display' as const, label: tr('targetDisplay') },
                    ]).map(({ key, label }) => (
                      <button
                        key={key}
                        type="button"
                        className={clsx(styles.placementChip, target.includes(key) && styles.placementChipActive)}
                        onClick={() => setTarget((prev) => prev.includes(key) ? prev.filter((x) => x !== key) : [...prev, key])}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{tr('scope')}</label>
                  <div className={styles.segmented}>
                    {(['global', 'character', 'chat'] as RegexScope[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={clsx(styles.segmentedBtn, scope === s && styles.segmentedBtnActive)}
                        onClick={() => setScope(s)}
                      >
                        {scopeLabels[s]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={styles.targetCol}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{tr('appliesTo')}</label>
                  <div className={styles.placementGrid}>
                    {([
                      { p: 'user_input' as const, label: tr('placementUser') },
                      { p: 'ai_output' as const, label: tr('placementAi') },
                      { p: 'world_info' as const, label: tr('placementWi') },
                      { p: 'reasoning' as const, label: tr('placementReasoning') },
                    ]).map(({ p, label }) => (
                      <button
                        key={p}
                        type="button"
                        className={clsx(styles.placementChip, placement.includes(p) && styles.placementChipActive)}
                        onClick={() => togglePlacement(p)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    {tr('depthRange')}
                    <span className={styles.fieldHint}>{tr('depthHint')}</span>
                  </label>
                  <div className={styles.depthRow}>
                    <input className={styles.depthInput} type="number" min="0" value={minDepth} onChange={(e) => setMinDepth(e.target.value)} placeholder={tr('depthAny')} />
                    <span className={styles.depthSep}>&ndash;</span>
                    <input className={styles.depthInput} type="number" min="0" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} placeholder={tr('depthAny')} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Advanced (collapsible) */}
          <div className={styles.section}>
            <button type="button" className={styles.sectionToggle} onClick={() => setAdvancedOpen(!advancedOpen)}>
              {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>{tr('advanced')}</span>
            </button>
            {advancedOpen && (
              <div className={styles.advancedContent}>
                <div className={styles.advancedRow}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>{tr('macroSubstitution')}</label>
                    <div className={styles.segmented}>
                      {([
                        { m: 'none' as const, label: tr('macroNone') },
                        { m: 'raw' as const, label: tr('macroRaw') },
                        { m: 'escaped' as const, label: tr('macroEscaped') },
                        { m: 'after' as const, label: tr('macroAfter') },
                      ]).map(({ m, label }) => (
                        <button
                          key={m}
                          type="button"
                          className={clsx(styles.segmentedBtn, substituteMacros === m && styles.segmentedBtnActive)}
                          onClick={() => setSubstituteMacros(m)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <Toggle.Checkbox
                    checked={runOnEdit}
                    onChange={setRunOnEdit}
                    label={tr('runOnEdit')}
                    className={styles.inlineToggle}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    {tr('trimStrings')}
                    <span className={styles.fieldHint}>{tr('trimHint')}</span>
                  </label>
                  <input className={styles.fieldInput} value={trimStrings} onChange={(e) => setTrimStrings(e.target.value)} placeholder={tr('trimPlaceholder')} />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{tr('notes')}</label>
                  <textarea className={styles.descTextarea} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder={tr('descPlaceholder')} />
                </div>
              </div>
            )}
          </div>

          {/* Live Test */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>{tr('liveTest')}</div>
            <div className={styles.testSection}>
              <textarea
                className={styles.testInput}
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder={tr('testPlaceholder')}
                rows={2}
              />
              {testResult && (
                <div className={styles.testResultArea}>
                  <div className={styles.testMeta}>
                    <span className={styles.matchBadge}>
                      {tr('matchCount', { count: testResult.matches })}
                    </span>
                    {testResult.error && <span className={styles.testError}>{testResult.error}</span>}
                  </div>
                  <div className={styles.testOutput}>{testResult.result}</div>
                </div>
              )}
              {testInput && !findRegex && (
                <div className={styles.testHint}>{tr('enterPatternHint')}</div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={closeModal}>{tc('actions.cancel')}</Button>
          <Button variant="primary" onClick={handleSave}>{tc('actions.save')}</Button>
        </div>
    </ModalShell>
  )
}
