import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
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

const REPLACE_TOKENS = [
  { label: '$&', value: '$&', hint: 'Insert the full matched text' },
  { label: '$1', value: '$1', hint: 'Insert captured group 1 (first set of parentheses)' },
  { label: '$2', value: '$2', hint: 'Insert captured group 2' },
  { label: '$3', value: '$3', hint: 'Insert captured group 3' },
  { label: '""', value: '', hint: 'Delete match (empty replacement)' },
] as const

const REPLACE_HTML_PRESETS = [
  { label: '<b>$1</b>', hint: 'Wrap group 1 in bold' },
  { label: '<i>$1</i>', hint: 'Wrap group 1 in italic' },
  { label: '<span class="">$1</span>', hint: 'Wrap group 1 in a span (add your CSS class)' },
  { label: '<mark>$1</mark>', hint: 'Highlight group 1' },
  { label: '<del>$1</del>', hint: 'Strikethrough group 1' },
  { label: '<details><summary>$1</summary>$2</details>', hint: 'Collapsible section' },
] as const

const FIND_PRESETS = [
  { label: 'OOC block', find: '\\(OOC:.*?\\)', replace: '', desc: 'Match (OOC: ...) blocks' },
  { label: 'Between tags', find: '<(\\w+)>(.*?)</\\1>', replace: '$2', desc: 'Content between matching HTML tags' },
  { label: 'Asterisk actions', find: '\\*([^*]+)\\*', replace: '<i>$1</i>', desc: 'Convert *actions* to italic HTML' },
  { label: 'Quoted speech', find: '"([^"]+)"', replace: '<span class="dialogue">"$1"</span>', desc: 'Wrap "dialogue" in a span' },
  { label: 'Strip HTML tags', find: '<[^>]+>', replace: '', desc: 'Remove all HTML tags' },
] as const

export default function RegexEditorModal() {
  const modalProps = useStore((s) => s.modalProps)
  const closeModal = useStore((s) => s.closeModal)
  const regexScripts = useStore((s) => s.regexScripts)
  const updateRegexScript = useStore((s) => s.updateRegexScript)

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
  const [target, setTarget] = useState<RegexTarget>('response')
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
      setTarget(script.target)
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
      await updateRegexScript(scriptId, {
        name: name.trim(),
        script_id: userScriptId,
        find_regex: findRegex,
        replace_string: replaceString,
        flags,
        placement,
        target,
        scope,
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
  }, [scriptId, name, userScriptId, findRegex, replaceString, flags, placement, target, scope, minDepth, maxDepth, substituteMacros, trimStrings, runOnEdit, description, folder, updateRegexScript, closeModal])

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
    <ModalShell isOpen={true} onClose={closeModal} maxWidth={720} zIndex={10001} className={styles.modal}>
        <div className={styles.header}>
          <h2 className={styles.title}>Edit Regex Script</h2>
          <CloseButton onClick={closeModal} size="sm" />
        </div>

        <div className={styles.body}>
          {/* Identity row: Name + Folder side by side */}
          <div className={styles.identityRow}>
            <div className={clsx(styles.field, styles.fieldGrow)}>
              <label className={styles.fieldLabel}>Name</label>
              <input className={styles.fieldInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Script name" />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                Script ID
                <span className={styles.fieldHint}>for macros</span>
              </label>
              <input
                className={clsx(styles.fieldInput, styles.monoText)}
                value={userScriptId}
                onChange={(e) => setUserScriptId(
                  e.target.value.toLowerCase().replace(/[\s\-]+/g, '_').replace(/[^a-z0-9_]/g, '')
                )}
                placeholder="e.g. censor"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Folder</label>
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
              <span>Presets</span>
            </button>
            {presetsOpen && (
              <div className={styles.presetGrid}>
                {FIND_PRESETS.map((p) => (
                  <button
                    key={p.label}
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
            <div className={styles.sectionLabel}>Find &amp; Replace</div>
            <div className={styles.field}>
              <div className={styles.findHeader}>
                <label className={styles.fieldLabel}>
                  Pattern
                  <span className={styles.fieldHint}>Use (groups) to capture for Replace</span>
                </label>
                <div className={styles.flagPills}>
                  {[
                    { f: 'g', hint: 'Global' },
                    { f: 'i', hint: 'Case insensitive' },
                    { f: 'm', hint: 'Multiline' },
                    { f: 's', hint: 'Dotall' },
                  ].map(({ f, hint }) => (
                    <button
                      key={f}
                      type="button"
                      className={clsx(styles.flagPill, flags.includes(f) && styles.flagPillActive)}
                      onClick={() => toggleFlag(f)}
                      title={hint}
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
                placeholder="e.g. \(OOC:.*?\)  or  <tag>(.*?)</tag>"
                rows={2}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                Replace with
                <span className={styles.fieldHint}>Supports $1 groups and HTML</span>
              </label>
              <div className={styles.tokenBar}>
                {REPLACE_TOKENS.map((t) => (
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
                {REPLACE_HTML_PRESETS.slice(0, 4).map((t) => (
                  <button
                    key={t.label}
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
                placeholder="Leave empty to delete matches, or use $1, $& and HTML"
                rows={2}
              />
            </div>
          </div>

          {/* Targeting — compact 2-col grid */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Targeting</div>
            <div className={styles.targetCols}>
              <div className={styles.targetCol}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Pipeline</label>
                  <div className={styles.segmented}>
                    {([
                      { t: 'prompt' as const, label: 'Prompt' },
                      { t: 'response' as const, label: 'Response' },
                      { t: 'display' as const, label: 'Display' },
                    ]).map(({ t, label }) => (
                      <button
                        key={t}
                        type="button"
                        className={clsx(styles.segmentedBtn, target === t && styles.segmentedBtnActive)}
                        onClick={() => setTarget(t)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Scope</label>
                  <div className={styles.segmented}>
                    {(['global', 'character', 'chat'] as RegexScope[]).map((s) => (
                      <button
                        key={s}
                        type="button"
                        className={clsx(styles.segmentedBtn, scope === s && styles.segmentedBtnActive)}
                        onClick={() => setScope(s)}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={styles.targetCol}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Applies to</label>
                  <div className={styles.placementGrid}>
                    {([
                      { p: 'user_input' as const, label: 'User' },
                      { p: 'ai_output' as const, label: 'AI' },
                      { p: 'world_info' as const, label: 'WI' },
                      { p: 'reasoning' as const, label: 'CoT' },
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
                    Depth range
                    <span className={styles.fieldHint}>0 = latest</span>
                  </label>
                  <div className={styles.depthRow}>
                    <input className={styles.depthInput} type="number" min="0" value={minDepth} onChange={(e) => setMinDepth(e.target.value)} placeholder="any" />
                    <span className={styles.depthSep}>&ndash;</span>
                    <input className={styles.depthInput} type="number" min="0" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} placeholder="any" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Advanced (collapsible) */}
          <div className={styles.section}>
            <button type="button" className={styles.sectionToggle} onClick={() => setAdvancedOpen(!advancedOpen)}>
              {advancedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              <span>Advanced</span>
            </button>
            {advancedOpen && (
              <div className={styles.advancedContent}>
                <div className={styles.advancedRow}>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Macro substitution</label>
                    <div className={styles.segmented}>
                      {([
                        { m: 'none' as const, label: 'None' },
                        { m: 'raw' as const, label: 'Raw' },
                        { m: 'escaped' as const, label: 'Escaped' },
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
                    label="Run on edit"
                    className={styles.inlineToggle}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Trim strings
                    <span className={styles.fieldHint}>comma separated</span>
                  </label>
                  <input className={styles.fieldInput} value={trimStrings} onChange={(e) => setTrimStrings(e.target.value)} placeholder="e.g. [OOC], (OOC)" />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Notes</label>
                  <textarea className={styles.descTextarea} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What does this script do?" />
                </div>
              </div>
            )}
          </div>

          {/* Live Test */}
          <div className={styles.section}>
            <div className={styles.sectionLabel}>Live Test</div>
            <div className={styles.testSection}>
              <textarea
                className={styles.testInput}
                value={testInput}
                onChange={(e) => setTestInput(e.target.value)}
                placeholder="Paste sample text to test..."
                rows={2}
              />
              {testResult && (
                <div className={styles.testResultArea}>
                  <div className={styles.testMeta}>
                    <span className={styles.matchBadge}>
                      {testResult.matches} match{testResult.matches !== 1 ? 'es' : ''}
                    </span>
                    {testResult.error && <span className={styles.testError}>{testResult.error}</span>}
                  </div>
                  <div className={styles.testOutput}>{testResult.result}</div>
                </div>
              )}
              {testInput && !findRegex && (
                <div className={styles.testHint}>Enter a find pattern above to see results</div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <Button variant="ghost" onClick={closeModal}>Cancel</Button>
          <Button variant="primary" onClick={handleSave}>Save</Button>
        </div>
    </ModalShell>
  )
}
