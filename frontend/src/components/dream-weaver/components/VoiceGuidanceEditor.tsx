import { useState, useCallback } from 'react'
import type { DreamWeaverDraft } from '../../../api/dream-weaver'
import styles from './VoiceGuidanceEditor.module.css'

type VoiceGuidance = DreamWeaverDraft['voice_guidance']
type RuleCategory = keyof VoiceGuidance['rules']

interface VoiceGuidanceEditorProps {
  voice: VoiceGuidance
  onChange: (voice: VoiceGuidance) => void
}

const CATEGORIES: { key: RuleCategory; label: string }[] = [
  { key: 'baseline', label: 'Baseline' },
  { key: 'rhythm', label: 'Rhythm' },
  { key: 'diction', label: 'Diction' },
  { key: 'quirks', label: 'Quirks' },
  { key: 'hard_nos', label: 'Hard Nos' },
]

export function VoiceGuidanceEditor({ voice, onChange }: VoiceGuidanceEditorProps) {
  const [view, setView] = useState<'structured' | 'compiled'>('structured')

  const updateRule = useCallback((category: RuleCategory, index: number, value: string) => {
    const newRules = { ...voice.rules }
    newRules[category] = [...newRules[category]]
    newRules[category][index] = value
    onChange({ ...voice, rules: newRules })
  }, [voice, onChange])

  const addRule = useCallback((category: RuleCategory) => {
    const newRules = { ...voice.rules }
    newRules[category] = [...newRules[category], '']
    onChange({ ...voice, rules: newRules })
  }, [voice, onChange])

  const removeRule = useCallback((category: RuleCategory, index: number) => {
    const newRules = { ...voice.rules }
    newRules[category] = newRules[category].filter((_, i) => i !== index)
    onChange({ ...voice, rules: newRules })
  }, [voice, onChange])

  return (
    <div className={styles.editor}>
      <div className={styles.viewToggle}>
        <button
          className={styles.toggleOption}
          data-active={view === 'structured' || undefined}
          onClick={() => setView('structured')}
        >
          Structured
        </button>
        <button
          className={styles.toggleOption}
          data-active={view === 'compiled' || undefined}
          onClick={() => setView('compiled')}
        >
          Compiled
        </button>
      </div>

      {view === 'compiled' ? (
        <div className={styles.compiled}>
          <p className={styles.compiledHint}>Read-only compiled output used at runtime.</p>
          <div className={styles.compiledText}>
            {voice.compiled || 'No compiled voice guidance yet.'}
          </div>
        </div>
      ) : (
        <div className={styles.categories}>
          {CATEGORIES.map(({ key, label }) => (
            <div key={key} className={styles.category}>
              <div className={styles.categoryHeader}>
                <span className={styles.categoryLabel}>{label}</span>
                <span className={styles.categoryCount}>{voice.rules[key].length}</span>
              </div>
              <div className={styles.rules}>
                {voice.rules[key].map((rule, i) => (
                  <div key={i} className={styles.ruleRow}>
                    <input
                      className={styles.ruleInput}
                      type="text"
                      value={rule}
                      onChange={(e) => updateRule(key, i, e.target.value)}
                      placeholder={`${label} rule...`}
                    />
                    <button className={styles.removeRule} onClick={() => removeRule(key, i)}>×</button>
                  </div>
                ))}
                <button className={styles.addRule} onClick={() => addRule(key)}>+ Add rule</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
