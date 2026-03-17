import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { X, ChevronDown, ChevronRight } from 'lucide-react'
import { useStore } from '@/store'
import { regexApi } from '@/api/regex'
import { toast } from '@/lib/toast'
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

  const replaceRef = useRef<HTMLTextAreaElement>(null)

  // Local state mirrors script for editing
  const [name, setName] = useState('')
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
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)

  // Live test
  const [testInput, setTestInput] = useState('')
  const [testResult, setTestResult] = useState<{ result: string; matches: number; error?: string } | null>(null)

  useEffect(() => {
    if (script) {
      setName(script.name)
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
      })
      closeModal()
    } catch (err: any) {
      toast.error(err.body?.error || err.message)
    }
  }, [scriptId, name, findRegex, replaceString, flags, placement, target, scope, minDepth, maxDepth, substituteMacros, trimStrings, runOnEdit, description, updateRegexScript, closeModal])

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

  return createPortal(
    <motion.div
      className={styles.overlay}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={closeModal}
    >
      <motion.div
        className={styles.modal}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Edit Regex Script</h2>
          <button className={styles.closeBtn} onClick={closeModal}><X size={16} /></button>
        </div>

        <div className={styles.body}>
          {/* Name */}
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input className={styles.fieldInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Script name" />
          </div>

          {/* Common Patterns (collapsible) */}
          <div className={styles.section}>
            <div className={styles.sectionTitle} onClick={() => setPresetsOpen(!presetsOpen)}>
              {presetsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Common Patterns
            </div>
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

          {/* Find + Replace */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Find &amp; Replace</div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                Find Pattern
                <span className={styles.fieldHint}>
                  Use (parentheses) to capture groups for use in Replace
                </span>
              </label>
              <textarea
                className={styles.monoInput}
                value={findRegex}
                onChange={(e) => setFindRegex(e.target.value)}
                placeholder="e.g. \(OOC:.*?\)  or  <tag>(.*?)</tag>"
                rows={2}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Flags</label>
              <div className={styles.flagsRow}>
                {[
                  { f: 'g', label: 'g', hint: 'Global — replace all matches, not just the first' },
                  { f: 'i', label: 'i', hint: 'Case insensitive' },
                  { f: 'm', label: 'm', hint: 'Multiline — ^ and $ match line boundaries' },
                  { f: 's', label: 's', hint: 'Dotall — . also matches newlines' },
                ].map(({ f, label, hint }) => (
                  <label key={f} className={styles.flagCheck} title={hint}>
                    <input type="checkbox" checked={flags.includes(f)} onChange={() => toggleFlag(f)} />
                    <span>{label}</span>
                    <span className={styles.flagHint}>{hint.split(' — ')[0]}</span>
                  </label>
                ))}
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>
                Replace With
                <span className={styles.fieldHint}>
                  What matched text becomes — click tokens to insert, supports HTML
                </span>
              </label>
              <div className={styles.tokenBar}>
                <span className={styles.tokenBarLabel}>Insert:</span>
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
                <span className={styles.tokenBarLabel}>HTML:</span>
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
                placeholder={'Leave empty to delete matches\n$& = full match, $1 = group 1, $2 = group 2\nHTML is supported: <b>$1</b>, <span class="x">$&</span>'}
                rows={3}
              />
            </div>
          </div>

          {/* Targeting */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Targeting</div>
            <div className={styles.targetGrid}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Applies to messages from</label>
                <div className={styles.checkRow}>
                  {([
                    { p: 'user_input' as const, label: 'User messages' },
                    { p: 'ai_output' as const, label: 'AI responses' },
                    { p: 'world_info' as const, label: 'World Info / System' },
                    { p: 'reasoning' as const, label: 'CoT / Reasoning' },
                  ]).map(({ p, label }) => (
                    <label key={p} className={styles.flagCheck}>
                      <input type="checkbox" checked={placement.includes(p)} onChange={() => togglePlacement(p)} />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Pipeline stage</label>
                <div className={styles.radioRow}>
                  {([
                    { t: 'prompt' as const, label: 'Prompt', hint: 'Modifies what the AI sees' },
                    { t: 'response' as const, label: 'Response', hint: 'Modifies saved AI output' },
                    { t: 'display' as const, label: 'Display', hint: 'Visual only, never saved' },
                  ]).map(({ t, label, hint }) => (
                    <label key={t} className={styles.radioLabel} title={hint}>
                      <input type="radio" name="target" checked={target === t} onChange={() => setTarget(t)} />
                      <span>{label}</span>
                      <span className={styles.radioHint}>{hint}</span>
                    </label>
                  ))}
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Scope</label>
                <div className={styles.radioRow}>
                  {(['global', 'character', 'chat'] as RegexScope[]).map((s) => (
                    <label key={s} className={styles.radioLabel}>
                      <input type="radio" name="scope" checked={scope === s} onChange={() => setScope(s)} />
                      {s.charAt(0).toUpperCase() + s.slice(1)}
                    </label>
                  ))}
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>
                  Message depth range
                  <span className={styles.fieldHint}>0 = latest message</span>
                </label>
                <div className={styles.depthRow}>
                  <span className={styles.depthLabel}>From</span>
                  <input className={styles.depthInput} type="number" min="0" value={minDepth} onChange={(e) => setMinDepth(e.target.value)} placeholder="any" />
                  <span className={styles.depthLabel}>to</span>
                  <input className={styles.depthInput} type="number" min="0" value={maxDepth} onChange={(e) => setMaxDepth(e.target.value)} placeholder="any" />
                </div>
              </div>
            </div>
          </div>

          {/* Advanced (collapsible) */}
          <div className={styles.section}>
            <div className={styles.sectionTitle} onClick={() => setAdvancedOpen(!advancedOpen)}>
              {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Advanced
            </div>
            {advancedOpen && (
              <div className={styles.advancedContent}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Macro substitution in find pattern
                    <span className={styles.fieldHint}>Expand {'{{macros}}'} in the regex before matching</span>
                  </label>
                  <div className={styles.radioRow}>
                    {([
                      { m: 'none' as const, label: 'None', hint: 'Pattern used as-is' },
                      { m: 'raw' as const, label: 'Raw', hint: 'Macros expanded literally' },
                      { m: 'escaped' as const, label: 'Escaped', hint: 'Macros escaped for regex safety' },
                    ]).map(({ m, label, hint }) => (
                      <label key={m} className={styles.radioLabel} title={hint}>
                        <input type="radio" name="macros" checked={substituteMacros === m} onChange={() => setSubstituteMacros(m)} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>
                    Trim strings
                    <span className={styles.fieldHint}>Strings to strip from the result after replacement (comma separated)</span>
                  </label>
                  <input className={styles.fieldInput} value={trimStrings} onChange={(e) => setTrimStrings(e.target.value)} placeholder="e.g. [OOC], (OOC)" />
                </div>
                <label className={styles.toggleRow}>
                  <input type="checkbox" checked={runOnEdit} onChange={(e) => setRunOnEdit(e.target.checked)} />
                  Run when user edits messages
                </label>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Description / Notes</label>
                  <textarea className={styles.descTextarea} value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What does this script do?" />
                </div>
              </div>
            )}
          </div>

          {/* Live Test */}
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Live Test</div>
            <div className={styles.testSection}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Input</label>
                <textarea
                  className={styles.testInput}
                  value={testInput}
                  onChange={(e) => setTestInput(e.target.value)}
                  placeholder="Paste sample text here to test your regex..."
                  rows={3}
                />
              </div>
              {testResult && (
                <>
                  <div className={styles.testMeta}>
                    <span className={styles.matchBadge}>
                      {testResult.matches} match{testResult.matches !== 1 ? 'es' : ''}
                    </span>
                    {testResult.error && <span className={styles.testError}>{testResult.error}</span>}
                  </div>
                  <div className={styles.field}>
                    <label className={styles.fieldLabel}>Output</label>
                    <div className={styles.testOutput}>{testResult.result}</div>
                  </div>
                </>
              )}
              {testInput && !findRegex && (
                <div className={styles.testHint}>Enter a find pattern above to see results</div>
              )}
            </div>
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.btn} onClick={closeModal}>Cancel</button>
          <button className={styles.btnPrimary} onClick={handleSave}>Save</button>
        </div>
      </motion.div>
    </motion.div>,
    document.body,
  )
}
