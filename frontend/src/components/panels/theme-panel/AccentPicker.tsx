import { useState, useRef, useCallback, useEffect } from 'react'
import styles from './AccentPicker.module.css'
import clsx from 'clsx'

interface AccentPickerProps {
  hue: number
  saturation: number
  luminance: number
  onChange: (h: number, s: number, l: number) => void
}

const SWATCHES = [0, 30, 60, 120, 152, 200, 220, 263, 290, 340]

export default function AccentPicker({ hue, saturation, luminance, onChange }: AccentPickerProps) {
  const [customOpen, setCustomOpen] = useState(false)
  const [localHue, setLocalHue] = useState(hue)
  const [localSat, setLocalSat] = useState(saturation)
  const [localLum, setLocalLum] = useState(luminance)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const rafRef = useRef<number>(undefined)

  // Sync local state when prop changes externally (e.g. preset selection)
  useEffect(() => {
    setLocalHue(hue)
    setLocalSat(saturation)
    setLocalLum(luminance)
  }, [hue, saturation, luminance])

  const debouncedOnChange = useCallback(
    (h: number, s: number, l: number) => {
      clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => onChange(h, s, l), 300)
    },
    [onChange]
  )

  const applyPreview = useCallback(
    (h: number, s: number, l: number) => {
      cancelAnimationFrame(rafRef.current!)
      rafRef.current = requestAnimationFrame(() => {
        document.documentElement.style.setProperty(
          '--lumiverse-primary',
          `hsla(${h}, ${s}%, ${l}%, 0.9)`
        )
      })
    },
    []
  )

  const handleHueSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const h = Number(e.target.value)
      setLocalHue(h)
      applyPreview(h, localSat, localLum)
      debouncedOnChange(h, localSat, localLum)
    },
    [localSat, localLum, applyPreview, debouncedOnChange]
  )

  const handleSatSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const s = Number(e.target.value)
      setLocalSat(s)
      applyPreview(localHue, s, localLum)
      debouncedOnChange(localHue, s, localLum)
    },
    [localHue, localLum, applyPreview, debouncedOnChange]
  )

  const handleLumSlider = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const l = Number(e.target.value)
      setLocalLum(l)
      applyPreview(localHue, localSat, l)
      debouncedOnChange(localHue, localSat, l)
    },
    [localHue, localSat, applyPreview, debouncedOnChange]
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
              onChange(h, saturation, luminance)
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
          <label className={styles.sliderRow}>
            <span className={styles.sliderLabel}>Luminance</span>
            <input
              type="range"
              min={30}
              max={80}
              value={localLum}
              onChange={handleLumSlider}
              className={styles.lumSlider}
              style={{
                '--lum-track-bg': `linear-gradient(to right, hsl(${localHue}, ${localSat}%, 30%), hsl(${localHue}, ${localSat}%, 55%), hsl(${localHue}, ${localSat}%, 80%))`,
              } as React.CSSProperties}
            />
            <span className={styles.sliderValue}>{localLum}%</span>
          </label>
        </div>
      )}
    </div>
  )
}
