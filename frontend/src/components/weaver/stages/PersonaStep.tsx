import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { emptyPersonaPlan, type PersonaDraft, type PersonaDepthEntry, type WeaverPersonaPlan, type WeaverSession } from '@/api/weaver'
import SearchableSelect, { type SearchableSelectOption } from '@/components/shared/SearchableSelect'
import { Band, Btn, IconBtn } from '../primitives'
import styles from '../WeaverStudio.module.css'

const PERSIST_MS = 700

interface PersonaStepProps {
  session: WeaverSession
  onBack: () => void
  onContinue: () => void
}

export function PersonaStep({ session, onBack, onContinue }: PersonaStepProps) {
  const { t } = useTranslation('weaver')
  const buildTypes = useStore((s) => s.weaverBuildTypes)
  const registers = useStore((s) => s.weaverPersonaRegisters)
  const loadRegisters = useStore((s) => s.loadWeaverPersonaRegisters)
  const savePlan = useStore((s) => s.setWeaverPersonaPlan)
  const generate = useStore((s) => s.generateWeaverPersona)
  const generating = useStore((s) => s.weaverPersonaGenerating)
  const generateGreeting = useStore((s) => s.generateWeaverPersonaGreeting)
  const greetingGenerating = useStore((s) => s.weaverPersonaGreetingGenerating)
  const error = useStore((s) => s.weaverPersonaError)

  const supportsPairing = useMemo(
    () => buildTypes.find((b) => b.id === session.build_type)?.pairing === true,
    [buildTypes, session.build_type],
  )

  const initialPlan = session.persona_plan ?? emptyPersonaPlan()
  const [seed, setSeed] = useState(initialPlan.seed)
  const [draft, setDraft] = useState<PersonaDraft | null>(initialPlan.draft)
  const [pairing, setPairing] = useState(initialPlan.pairing)

  useEffect(() => {
    if (supportsPairing) void loadRegisters()
  }, [supportsPairing, loadRegisters])

  const planNow = (): WeaverPersonaPlan => ({ enabled: true, seed, draft, pairing })

  // Debounced persistence so the committed-at-finalize plan always reflects edits, even
  // if the user jumps straight to finalize via the stage track.
  useEffect(() => {
    const id = setTimeout(() => { void savePlan(session.id, { enabled: true, seed, draft, pairing }) }, PERSIST_MS)
    return () => clearTimeout(id)
  }, [seed, draft, pairing, session.id, savePlan])

  const registerOptions = useMemo<SearchableSelectOption[]>(
    () => registers.map((r) => ({ value: r.id, label: t(`persona.register.${r.id}`, { defaultValue: r.label }) })),
    [registers, t],
  )

  const handleGenerate = async () => {
    // Persist the seed first so the engine reads the latest idea.
    await savePlan(session.id, { enabled: true, seed, draft, pairing })
    const d = await generate(session.id)
    setDraft(d)
  }

  const handleGreeting = async () => {
    if (!draft) return
    const text = await generateGreeting(session.id, draft, pairing.register)
    setPairing((p) => ({ ...p, greeting_text: text }))
  }

  const handleContinue = async () => {
    await savePlan(session.id, planNow())
    onContinue()
  }

  const patch = (next: Partial<PersonaDraft>) => { if (draft) setDraft({ ...draft, ...next }) }
  const setSectionLines = (id: string, value: string) =>
    patch({ sections: draft!.sections.map((s) => (s.id === id ? { ...s, lines: value.split('\n') } : s)) })
  const setDepth = (i: number, next: Partial<PersonaDepthEntry>) =>
    patch({ depth: draft!.depth.map((d, idx) => (idx === i ? { ...d, ...next } : d)) })
  const removeDepth = (i: number) => patch({ depth: draft!.depth.filter((_, idx) => idx !== i) })
  const addDepth = () => patch({ depth: [...draft!.depth, { title: '', content: '', keys: [] }] })

  return (
    <>
      <div className={styles.panel}>
        <div className={styles.stageHead}>
          <div className={styles.stageHeadL}>
            <h2 className={styles.stageH}>{t('persona.step.heading')}</h2>
            <p className={styles.stageHelp}>{t('persona.step.help')}</p>
          </div>
        </div>
        {error && <p className={styles.errorText}>{error}</p>}
        <div className={styles.scroll}>
          <Band label={t('persona.step.ideaBand')}>
            <p className={styles.stageHelp}>{t('persona.step.ideaHelp')}</p>
            <textarea
              className={styles.field}
              value={seed}
              placeholder={t('persona.step.ideaPlaceholder')}
              onChange={(e) => setSeed(e.target.value)}
            />
            <Btn
              variant="primary"
              icon={generating ? 'refresh' : 'sparkles'}
              spin={generating}
              disabled={generating}
              onClick={() => void handleGenerate()}
            >
              {generating ? t('persona.step.generating') : draft ? t('persona.step.regenerate') : t('persona.step.generate')}
            </Btn>
          </Band>

          {draft && (
            <>
              <Band label={t('persona.review.identityBand')}>
                <div className={styles.personaIdRow}>
                  <div className={styles.configField}>
                    <span className={styles.configLabel}>{t('persona.review.name')}</span>
                    <input className={styles.field} value={draft.name} onChange={(e) => patch({ name: e.target.value })} />
                  </div>
                  <div className={styles.configField}>
                    <span className={styles.configLabel}>{t('persona.review.pronouns')}</span>
                    <div className={styles.personaPronouns}>
                      <input className={styles.field} value={draft.pronouns.subjective} placeholder="she"
                        onChange={(e) => patch({ pronouns: { ...draft.pronouns, subjective: e.target.value } })} />
                      <input className={styles.field} value={draft.pronouns.objective} placeholder="her"
                        onChange={(e) => patch({ pronouns: { ...draft.pronouns, objective: e.target.value } })} />
                      <input className={styles.field} value={draft.pronouns.possessive} placeholder="her"
                        onChange={(e) => patch({ pronouns: { ...draft.pronouns, possessive: e.target.value } })} />
                    </div>
                  </div>
                </div>
              </Band>

              <Band label={t('persona.review.bodyBand')}>
                <p className={styles.stageHelp}>{t('persona.review.bodyHelp')}</p>
                {draft.sections.map((s) => (
                  <div key={s.id} className={styles.personaSection}>
                    <span className={styles.configLabel}>{s.label}</span>
                    <textarea
                      className={styles.field}
                      value={s.lines.join('\n')}
                      placeholder={t('persona.review.sectionPlaceholder')}
                      onChange={(e) => setSectionLines(s.id, e.target.value)}
                    />
                  </div>
                ))}
              </Band>

              <Band label={t('persona.review.depthBand')} count={draft.depth.length}>
                <p className={styles.stageHelp}>{t('persona.review.depthHelp')}</p>
                {draft.depth.map((d, i) => (
                  <div key={i} className={styles.personaDepthRow}>
                    <div className={styles.personaDepthHead}>
                      <input className={styles.field} value={d.title} placeholder={t('persona.review.depthTitle')}
                        onChange={(e) => setDepth(i, { title: e.target.value })} />
                      <IconBtn icon="trash" size={14} title={t('persona.review.depthRemove')} onClick={() => removeDepth(i)} />
                    </div>
                    <textarea className={styles.field} value={d.content} placeholder={t('persona.review.depthContent')}
                      onChange={(e) => setDepth(i, { content: e.target.value })} />
                    <input className={styles.field} value={d.keys.join(', ')} placeholder={t('persona.review.depthKeys')}
                      onChange={(e) => setDepth(i, { keys: e.target.value.split(',').map((k) => k.trim()).filter(Boolean) })} />
                  </div>
                ))}
                <Btn icon="plus" onClick={addDepth}>{t('persona.review.depthAdd')}</Btn>
              </Band>

              {supportsPairing && (
                <Band label={t('persona.pairing.band')}>
                  <label className={styles.checkRow}>
                    <input type="checkbox" checked={pairing.greeting}
                      onChange={(e) => setPairing((p) => ({ ...p, greeting: e.target.checked }))} />
                    <span>{t('persona.pairing.toggle')}</span>
                  </label>
                  <p className={styles.stageHelp}>{t('persona.pairing.help')}</p>
                  {pairing.greeting && (
                    <>
                      <div className={styles.configField}>
                        <span className={styles.configLabel}>{t('persona.pairing.registerLabel')}</span>
                        <SearchableSelect
                          options={registerOptions}
                          value={pairing.register}
                          onChange={(v) => setPairing((p) => ({ ...p, register: v || 'neutral' }))}
                          ariaLabel={t('persona.pairing.registerLabel')}
                          portal
                        />
                      </div>
                      <Btn
                        icon={greetingGenerating ? 'refresh' : 'sparkles'}
                        spin={greetingGenerating}
                        disabled={greetingGenerating}
                        onClick={() => void handleGreeting()}
                      >
                        {greetingGenerating ? t('persona.pairing.generating') : t('persona.pairing.generate')}
                      </Btn>
                      <textarea
                        className={styles.field}
                        value={pairing.greeting_text}
                        placeholder={t('persona.pairing.placeholder')}
                        onChange={(e) => setPairing((p) => ({ ...p, greeting_text: e.target.value }))}
                      />
                    </>
                  )}
                </Band>
              )}
            </>
          )}
        </div>
      </div>
      <div className={styles.footer}>
        <Btn icon="arrowLeft" onClick={onBack}>{t('persona.step.back')}</Btn>
        <div className={styles.spacer} />
        <Btn variant="primary" iconRight="arrowRight" disabled={!draft} onClick={() => void handleContinue()}>
          {t('persona.step.continue')}
        </Btn>
      </div>
    </>
  )
}
