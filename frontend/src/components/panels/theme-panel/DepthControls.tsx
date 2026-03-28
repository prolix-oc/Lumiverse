import { Toggle } from '@/components/shared/Toggle'
import styles from './DepthControls.module.css'

interface DepthControlsProps {
  radiusScale: number
  enableGlass: boolean
  fontScale: number
  onRadiusChange: (v: number) => void
  onGlassToggle: (v: boolean) => void
  onFontScaleChange: (v: number) => void
}

function trackFill(value: number, min: number, max: number) {
  const pct = ((value - min) / (max - min)) * 100
  return {
    background: `linear-gradient(to right, var(--lumiverse-primary) ${pct}%, var(--lumiverse-fill-medium) ${pct}%)`,
  }
}

export default function DepthControls({
  radiusScale,
  enableGlass,
  fontScale,
  onRadiusChange,
  onGlassToggle,
  onFontScaleChange,
}: DepthControlsProps) {
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

      {/* Font scale */}
      <label className={styles.row}>
        <span className={styles.label}>Font Scale</span>
        <input
          type="range"
          min={0.85}
          max={1.15}
          step={0.05}
          value={fontScale}
          onChange={(e) => onFontScaleChange(Number(e.target.value))}
          className={styles.slider}
          style={trackFill(fontScale, 0.85, 1.15)}
        />
        <span className={styles.value}>{fontScale.toFixed(2)}x</span>
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
