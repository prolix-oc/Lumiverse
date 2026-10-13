import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/shared/Toggle'
import { MIN_UI_SCALE, MAX_UI_SCALE, normalizeUiScale } from '@/lib/uiScale'
import type { DesktopBackground, RenderingMode } from '@/types/theme'
import styles from './DepthControls.module.css'

interface DepthControlsProps {
  radiusScale: number
  enableGlass: boolean
  fontScale: number
  uiScale: number
  onRadiusChange: (v: number) => void
  onGlassToggle: (v: boolean) => void
  onFontScaleChange: (v: number) => void
  onUiScaleChange: (v: number) => void
  showDesktopBackgroundControls?: boolean
  desktopBackground?: DesktopBackground
  onDesktopBackgroundChange?: (value?: DesktopBackground) => void
  renderingMode?: RenderingMode
  onRenderingModeChange?: (value: RenderingMode) => void
}

const DEFAULT_DESKTOP_COLOR = '#0a0812'
const DEFAULT_DESKTOP_OPACITY = 72

function parseDesktopBackground(value?: string): { color: string; opacity: number } {
  if (!value) return { color: DEFAULT_DESKTOP_COLOR, opacity: DEFAULT_DESKTOP_OPACITY }

  const hex = value.match(/^#([\da-f]{6}|[\da-f]{8})$/i)
  if (hex) {
    const color = `#${hex[1].slice(0, 6)}`
    const opacity = hex[1].length === 8 ? Math.round((parseInt(hex[1].slice(6), 16) / 255) * 100) : 100
    return { color, opacity }
  }

  const rgb = value.match(/^rgba?\(\s*(\d+)\s*[ ,]\s*(\d+)\s*[ ,]\s*(\d+)(?:\s*(?:,|\/)\s*([\d.]+%?))?\s*\)$/i)
  if (rgb) {
    const opacity = rgb[4]
      ? rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) : Number(rgb[4]) * 100
      : 100
    const toHex = (channel: string) => Math.min(255, Math.max(0, Number(channel))).toString(16).padStart(2, '0')
    return {
      color: `#${toHex(rgb[1])}${toHex(rgb[2])}${toHex(rgb[3])}`,
      opacity: Math.min(100, Math.max(0, Math.round(opacity))),
    }
  }

  return { color: DEFAULT_DESKTOP_COLOR, opacity: DEFAULT_DESKTOP_OPACITY }
}

function desktopColor(color: string, opacity: number): string {
  const hex = color.slice(1)
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  return `rgb(${r} ${g} ${b} / ${opacity}%)`
}

function trackFill(value: number, min: number, max: number): React.CSSProperties {
  const pct = ((value - min) / (max - min)) * 100
  return {
    '--slider-fill': `linear-gradient(to right, var(--lumiverse-primary) ${pct}%, var(--lumiverse-fill-medium) ${pct}%)`,
  } as React.CSSProperties
}

/** Commit the current value from the range input's DOM node. */
function commitFromInput(e: React.SyntheticEvent, commit: (v: number) => void) {
  commit(Number((e.target as HTMLInputElement).value))
}

interface DeferredColorInputProps {
  value: string
  className?: string
  onCommit: (value: string) => void
}

/**
 * Let the native color chooser update its own small swatch while it is open,
 * then commit the selected color once. Committing every `input` event forces
 * the complete theme and translucent desktop surface to repaint under the
 * native blur, which makes dragging through the chooser extremely expensive.
 */
export function DeferredColorInput({ value, className, onCommit }: DeferredColorInputProps) {
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement>(null)
  const onCommitRef = useRef(onCommit)

  useEffect(() => { onCommitRef.current = onCommit }, [onCommit])
  useEffect(() => { setDraft(value) }, [value])

  useEffect(() => {
    const input = inputRef.current
    if (!input) return

    const handleChange = () => {
      setDraft(input.value)
      onCommitRef.current(input.value)
    }
    input.addEventListener('change', handleChange)
    return () => input.removeEventListener('change', handleChange)
  }, [])

  return (
    <input
      ref={inputRef}
      type="color"
      value={draft}
      onInput={(event) => setDraft(event.currentTarget.value)}
      className={className}
    />
  )
}

export default function DepthControls({
  radiusScale,
  enableGlass,
  fontScale,
  uiScale,
  onRadiusChange,
  onGlassToggle,
  onFontScaleChange,
  onUiScaleChange,
  showDesktopBackgroundControls = false,
  desktopBackground,
  onDesktopBackgroundChange,
  renderingMode = 'balanced',
  onRenderingModeChange,
}: DepthControlsProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'themePanel' })
  // Local state for sliders that should only commit on release.
  // This gives visual feedback during drag without triggering expensive
  // theme recalculations on every step.
  const [localFontScale, setLocalFontScale] = useState(fontScale)
  const [localUiScale, setLocalUiScale] = useState(() => normalizeUiScale(uiScale))
  const resolvedDesktopBackground = parseDesktopBackground(desktopBackground?.color)

  useEffect(() => { setLocalFontScale(fontScale) }, [fontScale])
  useEffect(() => { setLocalUiScale(normalizeUiScale(uiScale)) }, [uiScale])

  return (
    <div className={styles.controls}>
      {/* Radius scale */}
      <label className={styles.row}>
        <span className={styles.label}>{t('cornerRadius')}</span>
        <input
          type="range"
          min={0.5}
          max={2}
          step={0.1}
          value={radiusScale}
          onChange={(e) => onRadiusChange(Number(e.target.value))}
          className={styles.slider}
          style={trackFill(radiusScale, 0.5, 2)}
        />
        <span className={styles.value}>{radiusScale.toFixed(1)}x</span>
      </label>

      {/* Font scale — commits on release */}
      <label className={styles.row}>
        <span className={styles.label}>{t('fontScale')}</span>
        <input
          type="range"
          min={0.85}
          max={2}
          step={0.05}
          value={localFontScale}
          onChange={(e) => setLocalFontScale(Number(e.target.value))}
          onPointerUp={(e) => commitFromInput(e, onFontScaleChange)}
          onKeyUp={(e) => commitFromInput(e, onFontScaleChange)}
          className={styles.slider}
          style={trackFill(localFontScale, 0.85, 2)}
        />
        <span className={styles.value}>{localFontScale.toFixed(2)}x</span>
      </label>

      {/* UI scale — commits on release */}
      <label className={styles.row}>
        <span className={styles.label}>{t('uiScale')}</span>
        <input
          type="range"
          min={MIN_UI_SCALE}
          max={MAX_UI_SCALE}
          step={0.05}
          value={localUiScale}
          onChange={(e) => setLocalUiScale(Number(e.target.value))}
          onPointerUp={(e) => commitFromInput(e, onUiScaleChange)}
          onKeyUp={(e) => commitFromInput(e, onUiScaleChange)}
          className={styles.slider}
          style={trackFill(localUiScale, MIN_UI_SCALE, MAX_UI_SCALE)}
        />
        <span className={styles.value}>{localUiScale.toFixed(2)}x</span>
      </label>

      {/* Glass toggle */}
      <Toggle.Checkbox
        checked={enableGlass}
        onChange={onGlassToggle}
        label={t('glassEffects')}
      />

      {showDesktopBackgroundControls && onDesktopBackgroundChange && (
        <>
          {onRenderingModeChange && (
            <label className={styles.row}>
              <span className={styles.label}>{t('renderingMode.label')}</span>
              <select
                value={renderingMode}
                onChange={(event) => onRenderingModeChange(event.target.value as RenderingMode)}
                className={styles.select}
                title={t('renderingMode.hint')}
              >
                <option value="efficiency">{t('renderingMode.efficiency')}</option>
                <option value="balanced">{t('renderingMode.balanced')}</option>
                <option value="quality">{t('renderingMode.quality')}</option>
              </select>
            </label>
          )}
          <Toggle.Checkbox
            checked={Boolean(desktopBackground)}
            onChange={(enabled) => onDesktopBackgroundChange(enabled
              ? {
                  color: desktopColor(DEFAULT_DESKTOP_COLOR, DEFAULT_DESKTOP_OPACITY),
                  blur: true,
                  blurIntensity: 'balanced',
                }
              : undefined)}
            label={t('desktopBackground.enable')}
            hint={t('desktopBackground.hint')}
          />

          {desktopBackground && (
            <div className={styles.desktopControls}>
              <label className={styles.row}>
                <span className={styles.label}>{t('desktopBackground.tint')}</span>
                <DeferredColorInput
                  value={resolvedDesktopBackground.color}
                  onCommit={(color) => onDesktopBackgroundChange({
                    ...desktopBackground,
                    color: desktopColor(color, resolvedDesktopBackground.opacity),
                  })}
                  className={styles.colorInput}
                />
              </label>

              <label className={styles.row}>
                <span className={styles.label}>{t('desktopBackground.opacity')}</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={resolvedDesktopBackground.opacity}
                  onChange={(event) => onDesktopBackgroundChange({
                    ...desktopBackground,
                    color: desktopColor(resolvedDesktopBackground.color, Number(event.target.value)),
                  })}
                  className={styles.slider}
                  style={trackFill(resolvedDesktopBackground.opacity, 0, 100)}
                />
                <span className={styles.value}>{resolvedDesktopBackground.opacity}%</span>
              </label>

              <Toggle.Checkbox
                checked={desktopBackground.blur === true}
                onChange={(blur) => onDesktopBackgroundChange({ ...desktopBackground, blur })}
                label={t('desktopBackground.blur')}
              />

              {desktopBackground.blur && (
                <label className={styles.row}>
                  <span className={styles.label}>{t('desktopBackground.blurIntensity')}</span>
                  <select
                    value={desktopBackground.blurIntensity ?? 'balanced'}
                    onChange={(event) => onDesktopBackgroundChange({
                      ...desktopBackground,
                      blurIntensity: event.target.value as DesktopBackground['blurIntensity'],
                    })}
                    className={styles.select}
                  >
                    <option value="subtle">{t('desktopBackground.blurIntensitySubtle')}</option>
                    <option value="balanced">{t('desktopBackground.blurIntensityBalanced')}</option>
                    <option value="strong">{t('desktopBackground.blurIntensityStrong')}</option>
                  </select>
                </label>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
