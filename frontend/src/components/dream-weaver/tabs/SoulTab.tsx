import { Sparkles } from 'lucide-react'
import { generateUUID } from '@/lib/uuid'
import { Spinner } from '@/components/shared/Spinner'
import { StickySection } from '../components/StickySection'
import { VoiceGuidanceEditor } from '../components/VoiceGuidanceEditor'
import type { DreamWeaverAlternateField, DreamWeaverDraft, DreamWeaverGreeting, ExtendTarget } from '../../../api/dream-weaver'
import type { SectionStatus } from '../hooks/useDreamWeaverStudio'
import styles from './SoulTab.module.css'

interface SoulTabProps {
  draft: DreamWeaverDraft | null
  extending: Record<string, boolean>
  onUpdateCard: (patch: Partial<DreamWeaverDraft['card']>) => void
  onUpdateAlternates: (alternates: DreamWeaverDraft['alternate_fields']) => void
  onUpdateGreetings: (greetings: DreamWeaverDraft['greetings']) => void
  onUpdateVoice: (voice: DreamWeaverDraft['voice_guidance']) => void
  onExtend: (target: ExtendTarget, instruction?: string) => Promise<void>
  getSectionStatus: (section: string) => SectionStatus
}

export function SoulTab({
  draft,
  extending,
  onUpdateCard,
  onUpdateAlternates,
  onUpdateGreetings,
  onUpdateVoice,
  onExtend,
  getSectionStatus,
}: SoulTabProps) {
  const updateAlternateField = (
    fieldType: keyof DreamWeaverDraft['alternate_fields'],
    index: number,
    patch: Partial<DreamWeaverAlternateField>,
  ) => {
    if (!draft) return

    const updated = { ...draft.alternate_fields }
    updated[fieldType] = [...updated[fieldType]]
    updated[fieldType][index] = { ...updated[fieldType][index], ...patch }
    onUpdateAlternates(updated)
  }

  const removeAlternateField = (
    fieldType: keyof DreamWeaverDraft['alternate_fields'],
    index: number,
  ) => {
    if (!draft) return

    const updated = { ...draft.alternate_fields }
    updated[fieldType] = updated[fieldType].filter((_, itemIndex) => itemIndex !== index)
    onUpdateAlternates(updated)
  }

  const addAlternateField = (fieldType: keyof DreamWeaverDraft['alternate_fields']) => {
    if (!draft) return

    const updated = { ...draft.alternate_fields }
    updated[fieldType] = [...updated[fieldType], { id: generateUUID(), label: '', content: '' }]
    onUpdateAlternates(updated)
  }

  const updateGreeting = (index: number, patch: Partial<DreamWeaverGreeting>) => {
    if (!draft) return

    const updated = [...draft.greetings]
    updated[index] = { ...updated[index], ...patch }
    onUpdateGreetings(updated)
  }

  if (!draft) {
    return (
      <div className={styles.emptyState}>
        <p>No draft yet. Use the Dream panel to weave your first Soul draft.</p>
      </div>
    )
  }

  const card = draft.card
  const isCharacter = draft.kind !== 'scenario'

  return (
    <div className={styles.soulTab}>
      {/* Name */}
      <div className={styles.nameSection} id="section-name">
        <input
          className={styles.nameInput}
          type="text"
          value={card.name}
          onChange={(e) => onUpdateCard({ name: e.target.value })}
          placeholder="Character name..."
        />
      </div>

      {/* Appearance (character only) */}
      {isCharacter && (
        <StickySection
          id="appearance"
          label="Appearance"
          status={getSectionStatus('appearance')}
          color="var(--lumiverse-primary, #bd9dff)"
        >
          <textarea
            className={styles.sectionTextarea}
            value={card.appearance}
            onChange={(e) => onUpdateCard({ appearance: e.target.value })}
            placeholder="Structured appearance block..."
            rows={6}
          />
        </StickySection>
      )}

      {/* Description */}
      <StickySection
        id="description"
        label="Description"
        status={getSectionStatus('description')}
        color="var(--lumiverse-primary, #bd9dff)"
      >
        <textarea
          className={styles.sectionTextarea}
          value={card.description}
          onChange={(e) => onUpdateCard({ description: e.target.value })}
          placeholder="Core identity, physical presence, background, social texture..."
          rows={6}
        />
      </StickySection>

      {/* Personality */}
      <StickySection
        id="personality"
        label="Personality"
        status={getSectionStatus('personality')}
        color="#c990fb"
      >
        <textarea
          className={styles.sectionTextarea}
          value={card.personality}
          onChange={(e) => onUpdateCard({ personality: e.target.value })}
          placeholder="Core disposition, habits, interpersonal behavior, emotional fault lines..."
          rows={6}
        />
      </StickySection>

      {/* Scenario */}
      <StickySection
        id="scenario"
        label="Scenario"
        status={getSectionStatus('scenario')}
        color="#c990fb"
      >
        <textarea
          className={styles.sectionTextarea}
          value={card.scenario}
          onChange={(e) => onUpdateCard({ scenario: e.target.value })}
          placeholder="Present situation, immediate tension, relationship to {{user}}..."
          rows={4}
        />
      </StickySection>

      {/* First Message */}
      <StickySection
        id="first_mes"
        label="First Message"
        status={getSectionStatus('first_mes')}
        color="#ff8eac"
      >
        <textarea
          className={styles.sectionTextarea}
          value={card.first_mes}
          onChange={(e) => onUpdateCard({ first_mes: e.target.value })}
          placeholder="Opening message — must begin in motion..."
          rows={6}
        />
      </StickySection>

      {/* Voice Guidance */}
      <StickySection
        id="voice_guidance"
        label="Voice Guidance"
        status={getSectionStatus('voice_guidance')}
        color="#ff8eac"
      >
        <VoiceGuidanceEditor
          voice={draft.voice_guidance}
          onChange={onUpdateVoice}
        />
      </StickySection>

      <StickySection
        id="alternate_fields"
        label="Alternate Fields"
        status={getSectionStatus('alternate_fields')}
        color="#ff8eac"
      >
        {(['description', 'personality', 'scenario'] as const).map((fieldType) => {
          const extendTarget = `alternate_fields.${fieldType}` as ExtendTarget
          const isExtending = extending[extendTarget] ?? false

          return (
            <div key={fieldType} className={styles.alternateGroup}>
              <h4 className={styles.groupTitle}>{fieldType.charAt(0).toUpperCase() + fieldType.slice(1)} Alternates</h4>
              {draft.alternate_fields[fieldType].map((alt, idx) => (
                <div key={alt.id || idx} className={styles.entry}>
                  <input
                    className={styles.input}
                    placeholder="Label"
                    value={alt.label}
                    onChange={(e) => updateAlternateField(fieldType, idx, { label: e.target.value })}
                  />
                  <textarea
                    className={styles.entryTextarea}
                    value={alt.content}
                    onChange={(e) => updateAlternateField(fieldType, idx, { content: e.target.value })}
                    placeholder={`Alternate ${fieldType} content...`}
                    rows={3}
                  />
                  <button
                    className={styles.deleteEntry}
                    onClick={() => removeAlternateField(fieldType, idx)}
                  >&times;</button>
                </div>
              ))}
              <div className={styles.buttonRow}>
                <button
                  className={styles.addButton}
                  onClick={() => addAlternateField(fieldType)}
                >+ Add {fieldType} alternate</button>
                <button
                  className={styles.generateButton}
                  disabled={isExtending}
                  onClick={() => onExtend(extendTarget)}
                >
                  {isExtending ? <Spinner size={11} /> : <Sparkles size={11} />}
                  Generate
                </button>
              </div>
            </div>
          )
        })}
      </StickySection>

      <StickySection
        id="greetings"
        label="Greetings"
        status={getSectionStatus('greetings')}
        color="#ff8eac"
      >
        {draft.greetings.map((greeting, idx) => (
          <div key={greeting.id || idx} className={styles.entry}>
            <input
              className={styles.input}
              placeholder="Greeting label"
              value={greeting.label}
              onChange={(e) => updateGreeting(idx, { label: e.target.value })}
            />
            <textarea
              className={styles.entryTextarea}
              value={greeting.content}
              onChange={(e) => updateGreeting(idx, { content: e.target.value })}
              placeholder="Greeting content..."
              rows={5}
            />
            <button
              className={styles.deleteEntry}
              onClick={() => onUpdateGreetings(draft.greetings.filter((_, itemIndex) => itemIndex !== idx))}
            >&times;</button>
          </div>
        ))}
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => onUpdateGreetings([...draft.greetings, { id: generateUUID(), label: '', content: '' }])}
          >+ Add Greeting</button>
          <button
            className={styles.generateButton}
            disabled={extending.greetings ?? false}
            onClick={() => onExtend('greetings')}
          >
            {extending.greetings ? <Spinner size={11} /> : <Sparkles size={11} />}
            Generate
          </button>
        </div>
      </StickySection>

      {/* System Prompt */}
      <StickySection
        id="system_prompt"
        label="System Prompt"
        status={getSectionStatus('system_prompt')}
      >
        <textarea
          className={styles.sectionTextarea}
          value={card.system_prompt}
          onChange={(e) => onUpdateCard({ system_prompt: e.target.value })}
          placeholder="Optional system prompt override..."
          rows={3}
        />
      </StickySection>

      {/* Post-History Instructions */}
      <StickySection
        id="post_history_instructions"
        label="Post-History Instructions"
        status={getSectionStatus('post_history_instructions')}
      >
        <textarea
          className={styles.sectionTextarea}
          value={card.post_history_instructions}
          onChange={(e) => onUpdateCard({ post_history_instructions: e.target.value })}
          placeholder="Optional instructions inserted after chat history..."
          rows={3}
        />
      </StickySection>
    </div>
  )
}
