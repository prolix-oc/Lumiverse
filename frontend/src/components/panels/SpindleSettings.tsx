import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, PanelsLeftRight, SlidersHorizontal, Timer } from 'lucide-react'
import { useStore } from '@/store'
import { toast } from '@/lib/toast'
import styles from './SpindleSettings.module.css'

const DEFAULT_SECONDS = 10
const MIN_SECONDS = 1
const MAX_SECONDS = 300
const COLLAPSE_STORAGE_KEY = 'lumiverse:spindle:extension-settings-collapsed'

function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SECONDS
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, Math.round(n)))
}

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return true
  const value = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
  return value === null ? true : value === 'true'
}

export default function SpindleSettings() {
  const { t } = useTranslation('panels', { keyPrefix: 'spindlePanel.settings' })
  const spindleSettings = useStore((s) => s.spindleSettings)
  const setSetting = useStore((s) => s.setSetting)
  const [draft, setDraft] = useState<string>(String(DEFAULT_SECONDS))
  const [collapsed, setCollapsed] = useState(readCollapsedPreference)

  useEffect(() => {
    const ms = Number(spindleSettings.interceptorTimeoutMs)
    const value = Number.isFinite(ms) && ms > 0 ? clamp(ms / 1000) : DEFAULT_SECONDS
    setDraft(String(value))
  }, [spindleSettings.interceptorTimeoutMs])

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(collapsed))
  }, [collapsed])

  const commit = useCallback(async () => {
    const parsed = clamp(parseInt(draft, 10))
    setDraft(String(parsed))
    if (parsed === clamp(spindleSettings.interceptorTimeoutMs / 1000)) return
    setSetting('spindleSettings', {
      ...spindleSettings,
      interceptorTimeoutMs: parsed * 1000,
    })
    toast.success(t('toastTimeout', { seconds: parsed }), { title: t('brand') })
  }, [draft, spindleSettings, setSetting, t])

  const updateDockSide = useCallback((dockPanelDesktopSide: 'left' | 'right') => {
    if (spindleSettings.dockPanelDesktopSide === dockPanelDesktopSide) return
    setSetting('spindleSettings', {
      ...spindleSettings,
      dockPanelDesktopSide,
    })
    toast.success(t('toastDock', { side: t(dockPanelDesktopSide) }), { title: t('brand') })
  }, [spindleSettings, setSetting, t])

  return (
    <div className={styles.card}>
      <button
        type="button"
        className={styles.collapseHeader}
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className={styles.collapseTitle}>
          {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
          <SlidersHorizontal size={13} />
          {t('sectionTitle', { defaultValue: 'Extension settings' })}
        </span>
        <span className={styles.summary}>
          {draft}{t('secondsShort', { defaultValue: 's' })} · {t(spindleSettings.dockPanelDesktopSide)}
        </span>
      </button>

      {!collapsed && (
        <div className={styles.content}>
          <div className={styles.setting}>
            <div className={styles.headerRow}>
              <span className={styles.label}>
                <Timer size={12} /> {t('interceptorTimeout')}
              </span>
              <div className={styles.inputGroup}>
                <input
                  type="number"
                  name="spindle-interceptor-timeout"
                  aria-label={t('interceptorTimeoutAria')}
                  min={MIN_SECONDS}
                  max={MAX_SECONDS}
                  step={1}
                  value={draft}
                  className={styles.input}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={commit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      ;(e.target as HTMLInputElement).blur()
                    }
                  }}
                />
                <span className={styles.suffix}>{t('seconds')}</span>
              </div>
            </div>
            <p className={styles.hint}>
              {t('interceptorHint', { min: MIN_SECONDS, max: MAX_SECONDS, default: DEFAULT_SECONDS })}
            </p>
          </div>

          <div className={styles.setting}>
            <div className={styles.headerRow}>
              <span className={styles.label}>
                <PanelsLeftRight size={12} /> {t('dockPanelSide')}
              </span>
              <div className={styles.segmented}>
                <button
                  type="button"
                  className={styles.segmentedBtn}
                  data-active={spindleSettings.dockPanelDesktopSide === 'left'}
                  onClick={() => updateDockSide('left')}
                >
                  {t('left')}
                </button>
                <button
                  type="button"
                  className={styles.segmentedBtn}
                  data-active={spindleSettings.dockPanelDesktopSide === 'right'}
                  onClick={() => updateDockSide('right')}
                >
                  {t('right')}
                </button>
              </div>
            </div>
            <p className={styles.hint}>
              {t('dockHint')}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
