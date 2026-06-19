import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '@/i18n'

import { Plus, Trash2, FlaskConical, Check, X, Search, AlertTriangle, ChevronRight, KeyRound, ExternalLink } from 'lucide-react'
import { tokenizersApi, parseHfSource } from '@/api/tokenizers'
import { Badge } from '@/components/shared/Badge'
import type { TokenizerConfig, TokenizerModelPattern, TokenizerTestResult, PatternTestResult, ResolveTokenizerResult } from '@/api/tokenizers'
import styles from './TokenizerManager.module.css'

export default function TokenizerManager() {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')

  const [configs, setConfigs] = useState<TokenizerConfig[]>([])
  const [patterns, setPatterns] = useState<TokenizerModelPattern[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([tokenizersApi.list(), tokenizersApi.listPatterns()])
      .then(([c, p]) => { setConfigs(c); setPatterns(p) })
      .finally(() => setLoading(false))
  }, [])

  const refreshConfigs = () => tokenizersApi.list().then(setConfigs)
  const refreshPatterns = () => tokenizersApi.listPatterns().then(setPatterns)

  if (loading) return <div className={styles.container}>{t('tokenizers.loading')}</div>

  return (
    <div className={styles.container}>
      <HfAccessSection />
      <hr className={styles.divider} />
      <ConfigsSection configs={configs} onRefresh={refreshConfigs} />
      <hr className={styles.divider} />
      <PatternsSection patterns={patterns} configs={configs} onRefresh={refreshPatterns} />
      <hr className={styles.divider} />
      <TokenizerTestPanel configs={configs} />
      <hr className={styles.divider} />
      <PatternTestPanel />
    </div>
  )
}

// ---- HuggingFace Access Section ----

/** Owner-only, write-only HuggingFace token field. Unlocks gated/private repos. */
function HfAccessSection() {
  const { t } = useTranslation('settings')
  const [configured, setConfigured] = useState(false)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    tokenizersApi.getHfToken().then((r) => setConfigured(r.configured)).catch(() => {})
  }, [])

  const submit = async (value: string | null) => {
    setSaving(true); setError(''); setSaved(false)
    try {
      const r = await tokenizersApi.setHfToken(value)
      setConfigured(r.configured)
      setToken('')
      if (value) setSaved(true)
    } catch (err: any) {
      setError(err.body?.error || err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h3 className={styles.sectionTitle}>{t('tokenizers.hfTitle')}</h3>
      <p className={styles.sectionDesc}>{t('tokenizers.hfDesc')}</p>
      <div className={styles.hfStatus}>
        <KeyRound size={13} />
        <span>{configured ? t('tokenizers.hfConfigured') : t('tokenizers.hfNotSet')}</span>
        <a className={styles.repoLink} href="https://huggingface.co/settings/tokens" target="_blank" rel="noreferrer">
          {t('tokenizers.hfGetToken')} <ExternalLink size={11} />
        </a>
      </div>
      <div className={styles.inlineRow}>
        <input
          className={styles.input}
          type="password"
          autoComplete="off"
          value={token}
          placeholder={configured ? t('tokenizers.hfPlaceholderSet') : t('tokenizers.hfPlaceholderEmpty')}
          onChange={(e) => { setToken(e.target.value); setSaved(false) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && token.trim()) submit(token.trim()) }}
        />
        <button type="button" className={styles.submitBtn} onClick={() => submit(token.trim())} disabled={saving || !token.trim()}>
          {t('tokenizers.hfSave')}
        </button>
        {configured && (
          <button type="button" className={styles.iconBtn} style={{ fontSize: 12 }} onClick={() => submit(null)} disabled={saving}>
            {t('tokenizers.hfClear')}
          </button>
        )}
      </div>
      {saved && <p className={styles.hfSaved}>{t('tokenizers.hfSaved')}</p>}
      {error && <p className={styles.error}>{error}</p>}
    </section>
  )
}

// ---- Configs Section ----

/** Compact, human-readable summary of a tokenizer's config (no raw JSON / no scroll). */
function ConfigSummary({ config, type }: { config: Record<string, any>; type: string }) {
  const { t } = useTranslation('settings')

  if (type === 'huggingface' && config?.package) {
    return <span className={styles.metaLine}>package · <code className={styles.code}>{config.package}</code></span>
  }
  if ((type === 'huggingface' || type === 'tiktoken') && config?.url) {
    const src = parseHfSource(config)
    return (
      <div className={styles.sourceBlock}>
        {src.repo && (
          <div className={styles.repoRow}>
            <span className={styles.metaLabel}>{t('tokenizers.fromRepo')}</span>
            <a className={styles.repoLink} href={src.repoUrl ?? '#'} target="_blank" rel="noreferrer">{src.repo}</a>
            {src.revision && src.revision !== 'main' && <Badge color="neutral" size="sm">{src.revision}</Badge>}
          </div>
        )}
        <div className={styles.fileChips}>
          {src.files.map((f) => (
            <span key={f} className={styles.fileChip}><Check size={11} /> {f}</span>
          ))}
        </div>
      </div>
    )
  }
  if (type === 'openai' && config?.encoding) {
    return <span className={styles.metaLine}>encoding · <code className={styles.code}>{config.encoding}</code></span>
  }
  if (type === 'approximate') {
    return <span className={styles.metaLine}>≈ chars / {config?.charsPerToken ?? 4}</span>
  }
  return <span className={styles.metaLineMuted}>{JSON.stringify(config)}</span>
}

function TokenizerCard({ c, onDelete }: { c: TokenizerConfig; onDelete: (id: string) => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.cardTitle}>
          <span className={styles.cardName}>{c.name}</span>
          <Badge color="neutral" size="sm">{c.type}</Badge>
          {c.is_built_in && <Badge color="primary" size="sm">{t('tokenizers.builtIn')}</Badge>}
        </div>
        {!c.is_built_in && (
          <button type="button" className={styles.dangerBtn} onClick={() => onDelete(c.id)} title={i18n.t('actions.delete', { ns: 'common' })}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      <div className={styles.cardBody}>
        <ConfigSummary config={c.config} type={c.type} />
      </div>
    </div>
  )
}

function ConfigsSection({ configs, onRefresh }: { configs: TokenizerConfig[]; onRefresh: () => void }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')

  // Paste-a-URL flow
  const [url, setUrl] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolved, setResolved] = useState<ResolveTokenizerResult | null>(null)
  const [error, setError] = useState('')

  // Editable fields after a successful resolve
  const [name, setName] = useState('')
  const [autoMatch, setAutoMatch] = useState(true)
  const [pattern, setPattern] = useState('')
  const [priority, setPriority] = useState('60')
  const [installing, setInstalling] = useState(false)

  // Advanced manual entry
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [advName, setAdvName] = useState('')
  const [advType, setAdvType] = useState<string>('approximate')
  const [advConfigJson, setAdvConfigJson] = useState('{}')
  const [advError, setAdvError] = useState('')

  const handleResolve = async () => {
    if (!url.trim()) return
    setResolving(true); setError(''); setResolved(null)
    try {
      const r = await tokenizersApi.resolve(url.trim())
      setResolved(r)
      if (r.ok) {
        setName(r.suggested.name)
        setPattern(r.suggested.pattern)
        setPriority(String(r.suggested.priority))
        setAutoMatch(true)
      }
    } catch (err: any) {
      setError(err.body?.error || err.message)
    } finally {
      setResolving(false)
    }
  }

  const handleInstall = async () => {
    if (!resolved || !resolved.ok) return
    setInstalling(true); setError('')
    try {
      await tokenizersApi.install({
        name: name.trim() || resolved.suggested.name,
        type: resolved.type,
        config: resolved.suggested.config,
        pattern: autoMatch && pattern.trim()
          ? { pattern: pattern.trim(), priority: parseInt(priority, 10) || 60 }
          : undefined,
      })
      setUrl(''); setResolved(null); setName(''); setPattern('')
      onRefresh()
    } catch (err: any) {
      setError(err.body?.error || err.message)
    } finally {
      setInstalling(false)
    }
  }

  const handleAdvancedCreate = async () => {
    setAdvError('')
    try {
      const parsed = JSON.parse(advConfigJson)
      await tokenizersApi.install({ name: advName, type: advType, config: parsed })
      setAdvName(''); setAdvConfigJson('{}'); setShowAdvanced(false)
      onRefresh()
    } catch (err: any) {
      setAdvError(err.body?.error || err.message)
    }
  }

  const handleDelete = async (id: string) => {
    setError('')
    try {
      await tokenizersApi.remove(id)
      onRefresh()
    } catch (err: any) {
      setError(err.body?.error || err.message)
    }
  }

  const reasonTitle = (reason: 'unavailable' | 'unsupported' | 'invalid') =>
    reason === 'unsupported' ? t('tokenizers.reasonUnsupported')
      : reason === 'invalid' ? t('tokenizers.reasonInvalid')
        : t('tokenizers.reasonUnavailable')

  return (
    <section>
      <h3 className={styles.sectionTitle}>{t('tokenizers.configsTitle')}</h3>
      <p className={styles.sectionDesc}>{t('tokenizers.configsDesc')}</p>

      <div className={styles.cardList}>
        {configs.map((c) => <TokenizerCard key={c.id} c={c} onDelete={handleDelete} />)}
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {/* Primary path: paste a HuggingFace model URL */}
      <div className={styles.addBox}>
        <label className={styles.fieldLabel}>{t('tokenizers.pasteUrlLabel')}</label>
        <div className={styles.inlineRow}>
          <input
            className={styles.input}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('tokenizers.pasteUrlPlaceholder')}
            onKeyDown={(e) => { if (e.key === 'Enter') handleResolve() }}
          />
          <button type="button" className={styles.submitBtn} onClick={handleResolve} disabled={resolving || !url.trim()}>
            <Search size={13} /> {resolving ? t('tokenizers.resolving') : t('tokenizers.resolve')}
          </button>
        </div>

        {resolved && resolved.ok === false && (
          <div className={styles.resolveFail}>
            <AlertTriangle size={15} className={styles.failIcon} />
            <div>
              <div className={styles.resolveFailTitle}>{reasonTitle(resolved.reason)}</div>
              <div className={styles.resolveFailMsg}>{resolved.message}</div>
            </div>
          </div>
        )}

        {resolved && resolved.ok && (
          <div className={styles.resolveOk}>
            <div className={styles.repoRow}>
              <span className={styles.metaLabel}>{t('tokenizers.fromRepo')}</span>
              <a className={styles.repoLink} href={resolved.sourceUrl} target="_blank" rel="noreferrer">{resolved.repo}</a>
              <Badge color="neutral" size="sm">{resolved.type}</Badge>
              {resolved.revision !== 'main' && <Badge color="neutral" size="sm">{resolved.revision}</Badge>}
            </div>
            <div className={styles.fileChips}>
              {resolved.files.map((f) => (
                <span key={f.name} className={f.present ? styles.fileChip : styles.fileChipMissing}>
                  {f.present ? <Check size={11} /> : <X size={11} />} {f.name}
                </span>
              ))}
            </div>
            <div className={styles.verifiedLine}><Check size={12} /> {t('tokenizers.verified')}</div>
            {resolved.warnings.map((w, i) => (
              <div key={i} className={styles.warnLine}><AlertTriangle size={12} /> {w}</div>
            ))}

            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('tokenizers.nameCol')}</label>
              <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} />
            </div>

            <label className={styles.checkRow}>
              <input type="checkbox" checked={autoMatch} onChange={(e) => setAutoMatch(e.target.checked)} />
              <span>{t('tokenizers.autoMatchToggle')}</span>
            </label>
            {autoMatch && (
              <div className={styles.formRow}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>{t('tokenizers.usedForModels')}</label>
                  <input className={styles.input} style={{ fontFamily: 'monospace' }} value={pattern} onChange={(e) => setPattern(e.target.value)} />
                </div>
                <div className={styles.field} style={{ maxWidth: 80 }}>
                  <label className={styles.fieldLabel}>{t('tokenizers.priorityCol')}</label>
                  <input className={styles.input} type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
                </div>
              </div>
            )}

            <div className={styles.formRow}>
              <button type="button" className={styles.submitBtn} onClick={handleInstall} disabled={installing || !name.trim()}>
                <Plus size={13} /> {installing ? t('tokenizers.installing') : t('tokenizers.addFromRepo')}
              </button>
              <button type="button" className={styles.iconBtn} style={{ fontSize: 12 }} onClick={() => { setResolved(null); setError('') }}>{tc('actions.cancel')}</button>
            </div>
          </div>
        )}
      </div>

      {/* Advanced: manual config for non-HuggingFace tokenizers */}
      <div className={styles.advanced}>
        <button type="button" className={styles.advancedToggle} onClick={() => setShowAdvanced((v) => !v)}>
          <ChevronRight size={13} className={showAdvanced ? styles.chevronOpen : styles.chevron} /> {t('tokenizers.advanced')}
        </button>
        {showAdvanced && (
          <div className={styles.form}>
            <p className={styles.advancedDesc}>{t('tokenizers.advancedDesc')}</p>
            <div className={styles.formRow}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>{t('tokenizers.nameCol')}</label>
                <input className={styles.input} value={advName} onChange={(e) => setAdvName(e.target.value)} placeholder={t('tokenizers.myTokenizer')} />
              </div>
              <div className={styles.field} style={{ maxWidth: 140 }}>
                <label className={styles.fieldLabel}>{t('tokenizers.typeCol')}</label>
                <select className={styles.select} value={advType} onChange={(e) => setAdvType(e.target.value)}>
                  <option value="openai">OpenAI</option>
                  <option value="huggingface">HuggingFace</option>
                  <option value="tiktoken">Tiktoken</option>
                  <option value="approximate">Approximate</option>
                </select>
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('tokenizers.configJson')}</label>
              <textarea className={styles.textarea} value={advConfigJson} onChange={(e) => setAdvConfigJson(e.target.value)} rows={2} />
            </div>
            {advError && <p className={styles.error}>{advError}</p>}
            <div className={styles.formRow}>
              <button type="button" className={styles.submitBtn} onClick={handleAdvancedCreate} disabled={!advName}>{t('tokenizers.create')}</button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---- Patterns Section ----

function PatternsSection({ patterns, configs, onRefresh }: { patterns: TokenizerModelPattern[]; configs: TokenizerConfig[]; onRefresh: () => void }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [showForm, setShowForm] = useState(false)
  const [tokenizerId, setTokenizerId] = useState('')
  const [pattern, setPattern] = useState('')
  const [priority, setPriority] = useState('0')
  const [error, setError] = useState('')

  const configMap = Object.fromEntries(configs.map((c) => [c.id, c.name]))

  const handleCreate = async () => {
    setError('')
    try {
      await tokenizersApi.createPattern({ tokenizer_id: tokenizerId, pattern, priority: parseInt(priority, 10) || 0 })
      setPattern(''); setPriority('0'); setShowForm(false)
      onRefresh()
    } catch (err: any) {
      setError(err.body?.error || err.message)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await tokenizersApi.removePattern(id)
      onRefresh()
    } catch (err: any) {
      setError(err.body?.error || err.message)
    }
  }

  return (
    <section>
      <h3 className={styles.sectionTitle}>{t('tokenizers.patternsTitle')}</h3>
      <p className={styles.sectionDesc}>{t('tokenizers.patternsDesc')}</p>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>{t('tokenizers.patternCol')}</th>
              <th>{t('tokenizers.tokenizerCol')}</th>
              <th>{t('tokenizers.priorityCol')}</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {patterns.map((p) => (
              <tr key={p.id}>
                <td style={{ fontFamily: 'monospace', fontSize: 11 }}>
                  {p.pattern}
                  {p.is_built_in && <Badge color="primary" size="sm" className={styles.builtInBadgeSpacing}>{t('tokenizers.builtIn')}</Badge>}
                </td>
                <td>{configMap[p.tokenizer_id] || p.tokenizer_id}</td>
                <td>{p.priority}</td>
                <td>
                  <div className={styles.actions}>
                    {!p.is_built_in && (
                      <button type="button" className={styles.dangerBtn} onClick={() => handleDelete(p.id)} title={i18n.t('actions.delete', { ns: 'common' })}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className={styles.error}>{error}</p>}

      {!showForm ? (
        <button type="button" className={styles.submitBtn} onClick={() => setShowForm(true)} style={{ marginTop: 8 }}>
          <Plus size={13} /> {t('tokenizers.addPattern')}
        </button>
      ) : (
        <div className={styles.form}>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>{t('tokenizers.patternCol')}</label>
              <input className={styles.input} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="^my-model-" />
            </div>
            <div className={styles.field} style={{ maxWidth: 160 }}>
              <label className={styles.fieldLabel}>{t('tokenizers.tokenizerCol')}</label>
              <select className={styles.select} value={tokenizerId} onChange={(e) => setTokenizerId(e.target.value)}>
                <option value="">{tc('actions.select')}</option>
                {configs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className={styles.field} style={{ maxWidth: 80 }}>
              <label className={styles.fieldLabel}>{t('tokenizers.priorityCol')}</label>
              <input className={styles.input} type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
            </div>
          </div>
          <div className={styles.formRow}>
            <button type="button" className={styles.submitBtn} onClick={handleCreate} disabled={!pattern || !tokenizerId}>{t('tokenizers.create')}</button>
            <button type="button" className={styles.iconBtn} onClick={() => setShowForm(false)} style={{ fontSize: 12 }}>{tc('actions.cancel')}</button>
          </div>
        </div>
      )}
    </section>
  )
}

// ---- Tokenizer Test Panel ----

function TokenizerTestPanel({ configs }: { configs: TokenizerConfig[] }) {
  const { t } = useTranslation('settings')
  const { t: tc } = useTranslation('common')
  const [tokenizerId, setTokenizerId] = useState('')
  const [text, setText] = useState('')
  const [result, setResult] = useState<TokenizerTestResult | null>(null)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')

  const handleTest = async () => {
    if (!tokenizerId || !text) return
    setTesting(true); setError(''); setResult(null)
    try {
      const r = await tokenizersApi.test(tokenizerId, text)
      setResult(r)
    } catch (err: any) {
      setError(err.body?.error || err.message)
    } finally {
      setTesting(false)
    }
  }

  return (
    <section>
      <h3 className={styles.sectionTitle}>{t('tokenizers.testTokenizer')}</h3>
      <p className={styles.sectionDesc}>{t('tokenizers.testTokenizerDesc')}</p>
      <div className={styles.testPanel}>
        <div className={styles.formRow}>
          <div className={styles.field} style={{ maxWidth: 200 }}>
            <label className={styles.fieldLabel}>{t('tokenizers.tokenizerCol')}</label>
            <select className={styles.select} value={tokenizerId} onChange={(e) => setTokenizerId(e.target.value)}>
              <option value="">{tc('actions.select')}</option>
              {configs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <button type="button" className={styles.submitBtn} onClick={handleTest} disabled={testing || !tokenizerId || !text}>
            <FlaskConical size={13} /> {testing ? t('tokenizers.testing') : t('tokenizers.runTest')}
          </button>
        </div>
        <textarea className={styles.textarea} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('tokenizers.enterSampleText')} rows={3} />
        {error && <p className={styles.error}>{error}</p>}
        {result && (
          <div className={styles.testResult}>
            <span className={styles.testResultLabel}>{t('tokenizers.tokensLabel')}: </span>
            <span className={styles.testResultValue}>{result.token_count}</span>
            {' | '}
            <span className={styles.testResultLabel}>{t('tokenizers.charsLabel')}: </span>
            <span className={styles.testResultValue}>{result.char_count}</span>
            {' | '}
            <span className={styles.testResultLabel}>{t('tokenizers.charsPerTokenLabel')}: </span>
            <span className={styles.testResultValue}>{result.chars_per_token}</span>
          </div>
        )}
      </div>
    </section>
  )
}

// ---- Pattern Test Panel ----

function PatternTestPanel() {
  const { t } = useTranslation('settings')
  const [modelId, setModelId] = useState('')
  const [result, setResult] = useState<PatternTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const handleTest = async () => {
    if (!modelId) return
    setTesting(true); setResult(null)
    try {
      const r = await tokenizersApi.testPattern(modelId)
      setResult(r)
    } catch {
      setResult(null)
    } finally {
      setTesting(false)
    }
  }

  return (
    <section>
      <h3 className={styles.sectionTitle}>{t('tokenizers.testPatternTitle')}</h3>
      <p className={styles.sectionDesc}>{t('tokenizers.testPatternDesc')}</p>
      <div className={styles.testPanel}>
        <div className={styles.formRow}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>{t('tokenizers.modelId')}</label>
            <input className={styles.input} value={modelId} onChange={(e) => setModelId(e.target.value)} placeholder="gpt-4o-mini" />
          </div>
          <button type="button" className={styles.submitBtn} onClick={handleTest} disabled={testing || !modelId}>
            <FlaskConical size={13} /> {t('tokenizers.runTest')}
          </button>
        </div>
        {result && (
          <div className={styles.testResult}>
            {result.matched ? (
              <>
                <span className={styles.testResultLabel}>{t('tokenizers.matched')}: </span>
                <span className={styles.testResultValue}>{result.tokenizer_name}</span>
                <span className={styles.testResultLabel}> ({result.tokenizer_id})</span>
              </>
            ) : (
              <span className={styles.testResultLabel}>{t('tokenizers.noMatch')}</span>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
