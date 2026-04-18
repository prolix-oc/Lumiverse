import { useState, useEffect } from 'react'
import { Toggle } from '@/components/shared/Toggle'
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

export default function DepthControls({
  radiusScale,
  enableGlass,
  fontScale,
  uiScale,
  onRadiusChange,
  onGlassToggle,
  onFontScaleChange,
  onUiScaleChange,
}: DepthControlsProps) {
  // Local state for sliders that should only commit on release.
  // This gives visual feedback during drag without triggering expensive
  // theme recalculations on every step.
  const [localFontScale, setLocalFontScale] = useState(fontScale)
  const [localUiScale, setLocalUiScale] = useState(uiScale)

  useEffect(() => { setLocalFontScale(fontScale) }, [fontScale])
  useEffect(() => { setLocalUiScale(uiScale) }, [uiScale])

  return (
    <div className={styles.controls}>
      {/* Radius scale */}
      <label className={styles.row}>
        <span className={styles.label}>Corner Radius</span>
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
        <span className={styles.label}>Font Scale</span>
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
        <span className={styles.label}>UI Scale</span>
        <input
          type="range"
          min={0.8}
          max={1.5}
          step={0.05}
          value={localUiScale}
          onChange={(e) => setLocalUiScale(Number(e.target.value))}
          onPointerUp={(e) => commitFromInput(e, onUiScaleChange)}
          onKeyUp={(e) => commitFromInput(e, onUiScaleChange)}
          className={styles.slider}
          style={trackFill(localUiScale, 0.8, 1.5)}
        />
        <span className={styles.value}>{localUiScale.toFixed(2)}x</span>
      </label>

      {/* Glass toggle */}
      <Toggle.Checkbox
        checked={enableGlass}
        onChange={onGlassToggle}
        label="Glass effects"
      />
    </div>
  )
}
