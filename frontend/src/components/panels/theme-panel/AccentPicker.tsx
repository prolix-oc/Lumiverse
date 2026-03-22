import { useState, useRef, useCallback, useEffect } from 'react'
import styles from './AccentPicker.module.css'
import clsx from 'clsx'

interface AccentPickerProps {
  hue: number
  saturation: number
  onChange: (h: number, s: number) => void
}

const SWATCHES = [0, 30, 60, 120, 152, 200, 220, 263, 290, 340]

export default function AccentPicker({ hue, saturation, onChange }: AccentPickerProps) {
  const [customOpen, setCustomOpen] = useState(false)
  const [localHue, setLocalHue] = useState(hue)
  const [localSat, setLocalSat] = useState(saturation)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const rafRef = useRef<number>(undefined)

  // Sync local state when prop changes externally (e.g. preset selection)
  useEffect(() => {
    setLocalHue(hue)
    setLocalSat(saturation)
  }, [hue, saturation])

  const debouncedOnChange = useCallback(
    (h: number, s: number) => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => onChange(h, s), 300)
    },
    [onChange]
  )

  const handleHueSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const h = Number(e.target.value)
      setLocalHue(h)

      // Apply directly via RAF for smooth preview
      cancelAnimationFrame(rafRef.current!)
      rafRef.current = requestAnimationFrame(() => {
        document.documentElement.style.setProperty(
          '--lumiverse-primary',
          `hsla(${h}, ${localSat}%, 65%, 0.9)`
        )
      })

      debouncedOnChange(h, localSat)
    },
    [localSat, debouncedOnChange]
  )

  const handleSatSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const s = Number(e.target.value)
      setLocalSat(s)

      cancelAnimationFrame(rafRef.current!)
      rafRef.current = requestAnimationFrame(() => {
        document.documentElement.style.setProperty(
          '--lumiverse-primary',
          `hsla(${localHue}, ${s}%, 65%, 0.9)`
        )
      })

      debouncedOnChange(localHue, s)
    },
    [localHue, debouncedOnChange]
  )

  const isCustom = !SWATCHES.includes(hue)

  return (
    <div className={styles.picker}>
      <div className={styles.swatches}>
        {SWATCHES.map((h) => (
          <button
            key={h}
            type="button"
            className={clsx(styles.swatch, hue === h && !customOpen && styles.swatchActive)}
            style={{ background: `hsl(${h}, ${saturation}%, 65%)` }}
            onClick={() => {
              setCustomOpen(false)
              onChange(h, saturation)
            }}
          />
        ))}
        <button
          type="button"
          className={clsx(styles.customBtn, (customOpen || isCustom) && styles.customBtnActive)}
          onClick={() => setCustomOpen(!customOpen)}
        >
          Custom
        </button>
      </div>

      {(customOpen || isCustom) && (
        <div className={styles.sliders}>
          <label className={styles.sliderRow}>
            <span className={styles.sliderLabel}>Hue</span>
            <input
              type="range"
              min={0}
              max={360}
              value={localHue}
              onChange={handleHueSlider}
              className={styles.hueSlider}
            />
            <span className={styles.sliderValue}>{localHue}</span>
          </label>
          <label className={styles.sliderRow}>
            <span className={styles.sliderLabel}>Saturation</span>
            <input
              type="range"
              min={10}
              max={100}
              value={localSat}
              onChange={handleSatSlider}
              className={styles.satSlider}
            />
            <span className={styles.sliderValue}>{localSat}%</span>
          </label>
        </div>
      )}
    </div>
  )
}
