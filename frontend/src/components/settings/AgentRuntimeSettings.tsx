import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Activity, Archive, Gauge, RefreshCw, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/shared/FormComponents'
import { presetsApi } from '@/api/presets'
import type { AgentRuntimeHostLimits } from '@/types/agent-runtime'
import { AGENT_RUNTIME_LIMIT_GROUPS } from './AgentRuntimeSettingsModel'
import styles from './AgentRuntimeSettings.module.css'

export default function AgentRuntimeSettings() {
  const { t, i18n } = useTranslation('settings')
  const [limits, setLimits] = useState<AgentRuntimeHostLimits | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  const loadLimits = useCallback(async () => {
    setLoading(true)
    setFailed(false)
    try {
      setLimits(await presetsApi.getAgentRuntimeLimits())
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void loadLimits() }, [loadLimits])

  return (
    <section className={styles.runtime} aria-labelledby="agent-runtime-settings-title">
      <header className={styles.pageHeader}>
        <p className={styles.eyebrow}>{t('agentRuntimeSettings.eyebrow')}</p>
        <h2 id="agent-runtime-settings-title"><Activity aria-hidden="true" />{t('agentRuntimeSettings.title')}</h2>
        <p>{t('agentRuntimeSettings.description')}</p>
      </header>

      <section id="setsec-agentRuntime-defaults" className={styles.infoSection} aria-labelledby="agent-runtime-defaults-title">
        <div className={styles.sectionLead}>
          <ShieldCheck aria-hidden="true" />
          <div>
            <h3 id="agent-runtime-defaults-title">{t('agentRuntimeSettings.defaults.title')}</h3>
            <p>{t('agentRuntimeSettings.defaults.description')}</p>
          </div>
        </div>
        <ol className={styles.precedenceList}>
          <li><strong>{t('agentRuntimeSettings.defaults.oneTurn')}</strong><span>{t('agentRuntimeSettings.defaults.oneTurnHelp')}</span></li>
          <li><strong>{t('agentRuntimeSettings.defaults.chat')}</strong><span>{t('agentRuntimeSettings.defaults.chatHelp')}</span></li>
          <li><strong>{t('agentRuntimeSettings.defaults.preset')}</strong><span>{t('agentRuntimeSettings.defaults.presetHelp')}</span></li>
          <li><strong>{t('agentRuntimeSettings.defaults.response')}</strong><span>{t('agentRuntimeSettings.defaults.responseHelp')}</span></li>
        </ol>
      </section>

      <section id="setsec-agentRuntime-retention" className={styles.infoSection} aria-labelledby="agent-runtime-retention-title">
        <div className={styles.sectionLead}>
          <Archive aria-hidden="true" />
          <div>
            <h3 id="agent-runtime-retention-title">{t('agentRuntimeSettings.retention.title')}</h3>
            <p>{t('agentRuntimeSettings.retention.description')}</p>
          </div>
        </div>
        <dl className={styles.retentionList}>
          <div><dt>{t('agentRuntimeSettings.retention.operational')}</dt><dd>{t('agentRuntimeSettings.retention.operationalHelp')}</dd></div>
          <div><dt>{t('agentRuntimeSettings.retention.terminal')}</dt><dd>{t('agentRuntimeSettings.retention.terminalHelp')}</dd></div>
          <div><dt>{t('agentRuntimeSettings.retention.chatLifetime')}</dt><dd>{t('agentRuntimeSettings.retention.chatLifetimeHelp')}</dd></div>
        </dl>
      </section>

      <section id="setsec-agentRuntime-limits" className={styles.infoSection} aria-labelledby="agent-runtime-limits-title">
        <div className={styles.sectionLead}>
          <Gauge aria-hidden="true" />
          <div>
            <h3 id="agent-runtime-limits-title">{t('agentRuntimeSettings.limits.title')}</h3>
            <p>{t('agentRuntimeSettings.limits.description')}</p>
          </div>
        </div>
        {loading ? <p className={styles.statusText}>{t('agentRuntimeSettings.limits.loading')}</p> : failed || !limits ? (
          <div className={styles.error} role="alert">
            <span>{t('agentRuntimeSettings.limits.error')}</span>
            <Button className={styles.actionButton} icon={<RefreshCw aria-hidden="true" />} onClick={() => void loadLimits()}>
              {t('agentRuntimeSettings.limits.retry')}
            </Button>
          </div>
        ) : (
          <div className={styles.limitGroups}>
            {AGENT_RUNTIME_LIMIT_GROUPS.map((group) => (
              <section key={group.titleKey}>
                <h4>{t(group.titleKey)}</h4>
                <dl>
                  {group.keys.map((key) => (
                    <div key={key}>
                      <dt>{t(`agentRuntimeSettings.limits.fields.${key}`)}</dt>
                      <dd>{new Intl.NumberFormat(i18n.language).format(limits[key])}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        )}
        <p className={styles.readOnlyNote}>{t('agentRuntimeSettings.limits.readOnly')}</p>
      </section>
    </section>
  )
}
