import { useState, useRef, useCallback, useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import type { BaseColorKey, BaseColors } from '@/types/theme'
import styles from './BaseColorPicker.module.css'
import clsx from 'clsx'

// ── Color math helpers ──

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  h = ((h % 360) + 360) % 360
  s = s / 100
  v = v / 100
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) { r = c; g = x }
  else if (h < 120) { r = x; g = c }
  else if (h < 180) { g = c; b = x }
  else if (h < 240) { g = x; b = c }
  else if (h < 300) { r = x; b = c }
  else { r = c; b = x }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  const s = max === 0 ? 0 : (d / max) * 100
  const v = max * 100
  return [h, s, v]
}

function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.replace('#', '')
  if (m.length === 3) return [parseInt(m[0] + m[0], 16), parseInt(m[1] + m[1], 16), parseInt(m[2] + m[2], 16)]
  if (m.length === 6) return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)]
  return null
}

// ── Color key definitions ──

interface ColorDef {
  key: BaseColorKey
  label: string
  defaultColor: string
}

const COLOR_KEYS: ColorDef[] = [
  { key: 'primary',    label: 'Primary',    defaultColor: '#9370db' },
  { key: 'secondary',  label: 'Secondary',  defaultColor: '#808080' },
  { key: 'background', label: 'Background', defaultColor: '#1a1520' },
  { key: 'text',       label: 'Text',       defaultColor: '#e6e6e6' },
  { key: 'danger',     label: 'Danger',     defaultColor: '#ef4444' },
  { key: 'success',    label: 'Success',    defaultColor: '#22c55e' },
  { key: 'warning',    label: 'Warning',    defaultColor: '#f59e0b' },
  { key: 'speech',     label: 'Speech',     defaultColor: '#e6e6e6' },
  { key: 'thoughts',   label: 'Thoughts',   defaultColor: '#c8c8d4' },
]

// ── Component ──

interface BaseColorPickerProps {
  baseColors: BaseColors
  onChange: (colors: BaseColors) => void
}

export default function BaseColorPicker({ baseColors, onChange }: BaseColorPickerProps) {
  const [activeKey, setActiveKey] = useState<BaseColorKey>('primary')
  const [hexDraft, setHexDraft] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const hueRef = useRef<HTMLDivElement>(null)
  const draggingCanvas = useRef(false)
  const draggingHue = useRef(false)

  const activeDef = COLOR_KEYS.find(c => c.key === activeKey)!
  const currentHex = baseColors[activeKey] || activeDef.defaultColor
  const rgb = hexToRgb(currentHex) || [147, 112, 219]
  const [hue, sat, val] = rgbToHsv(rgb[0], rgb[1], rgb[2])

  // Reset hex draft when active key changes or color is updated externally
  useEffect(() => {
    setHexDraft(null)
  }, [activeKey, currentHex])

  // ── Canvas drawing ──

  const drawCanvas = useCallback((h: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const hh = canvas.height

    // White → pure hue (left to right)
    const hGrad = ctx.createLinearGradient(0, 0, w, 0)
    hGrad.addColorStop(0, '#fff')
    const [pr, pg, pb] = hsvToRgb(h, 100, 100)
    hGrad.addColorStop(1, `rgb(${pr},${pg},${pb})`)
    ctx.fillStyle = hGrad
    ctx.fillRect(0, 0, w, hh)

    // Transparent → black (top to bottom)
    const vGrad = ctx.createLinearGradient(0, 0, 0, hh)
    vGrad.addColorStop(0, 'rgba(0,0,0,0)')
    vGrad.addColorStop(1, '#000')
    ctx.fillStyle = vGrad
    ctx.fillRect(0, 0, w, hh)
  }, [])

  useEffect(() => {
    drawCanvas(hue)
  }, [hue, drawCanvas])

  // Resize canvas to match CSS size
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width
      canvas.height = rect.height
      drawCanvas(hue)
    })
    ro.observe(canvas)
    return () => ro.disconnect()
  }, [hue, drawCanvas])

  // ── Update color ──

  const setColor = useCallback((hex: string) => {
    onChange({ ...baseColors, [activeKey]: hex })
  }, [baseColors, activeKey, onChange])

  // ── Canvas interaction ──

  const pickFromCanvas = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    const newSat = x * 100
    const newVal = (1 - y) * 100
    const [r, g, b] = hsvToRgb(hue, newSat, newVal)
    setColor(rgbToHex(r, g, b))
  }, [hue, setColor])

  const handleCanvasDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    draggingCanvas.current = true
    const pos = 'touches' in e ? e.touches[0] : e
    pickFromCanvas(pos.clientX, pos.clientY)
  }, [pickFromCanvas])

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!draggingCanvas.current) return
      const pos = 'touches' in e ? e.touches[0] : e
      pickFromCanvas(pos.clientX, pos.clientY)
    }
    const handleUp = () => { draggingCanvas.current = false }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('touchmove', handleMove)
    window.addEventListener('touchend', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleUp)
    }
  }, [pickFromCanvas])

  // ── Hue slider interaction ──

  const pickHue = useCallback((clientX: number) => {
    const el = hueRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const newHue = x * 360
    const [r, g, b] = hsvToRgb(newHue, sat, val)
    setColor(rgbToHex(r, g, b))
  }, [sat, val, setColor])

  const handleHueDown = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    draggingHue.current = true
    const pos = 'touches' in e ? e.touches[0] : e
    pickHue(pos.clientX)
  }, [pickHue])

  useEffect(() => {
    const handleMove = (e: MouseEvent | TouchEvent) => {
      if (!draggingHue.current) return
      const pos = 'touches' in e ? e.touches[0] : e
      pickHue(pos.clientX)
    }
    const handleUp = () => { draggingHue.current = false }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    window.addEventListener('touchmove', handleMove)
    window.addEventListener('touchend', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      window.removeEventListener('touchmove', handleMove)
      window.removeEventListener('touchend', handleUp)
    }
  }, [pickHue])

  // ── Hex / RGB inputs ──

  const handleHexChange = useCallback((val: string) => {
    const cleaned = val.startsWith('#') ? val : '#' + val
    setHexDraft(cleaned)
    // Apply immediately if it's a valid 6-digit hex
    if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
      setColor(cleaned.toLowerCase())
    }
  }, [setColor])

  const commitHexDraft = useCallback(() => {
    if (hexDraft === null) return
    const cleaned = hexDraft.startsWith('#') ? hexDraft : '#' + hexDraft
    if (/^#[0-9a-fA-F]{6}$/.test(cleaned)) {
      setColor(cleaned.toLowerCase())
    }
    // Clear draft so the input shows the committed (or reverted) value
    setHexDraft(null)
  }, [hexDraft, setColor])

  const handleRgbInput = useCallback((channel: 0 | 1 | 2, val: string) => {
    const n = parseInt(val, 10)
    if (isNaN(n) || n < 0 || n > 255) return
    const newRgb: [number, number, number] = [rgb[0], rgb[1], rgb[2]]
    newRgb[channel] = n
    setColor(rgbToHex(newRgb[0], newRgb[1], newRgb[2]))
  }, [rgb, setColor])

  // ── Actions ──

  const handleReset = useCallback(() => {
    const updated = { ...baseColors }
    delete updated[activeKey]
    onChange(updated)
  }, [baseColors, activeKey, onChange])

  // Canvas cursor position
  const cursorX = `${(sat / 100) * 100}%`
  const cursorY = `${(1 - val / 100) * 100}%`
  const huePct = `${(hue / 360) * 100}%`

  return (
    <div className={styles.container}>
      {/* Color category swatches */}
      <div className={styles.swatchRow}>
        {COLOR_KEYS.map(({ key, label, defaultColor }) => (
          <button
            key={key}
            type="button"
            className={clsx(styles.swatchBtn, activeKey === key && styles.swatchBtnActive)}
            onClick={() => setActiveKey(key)}
          >
            <div
              className={styles.swatchCircle}
              style={{ background: baseColors[key] || defaultColor }}
            />
            <span className={styles.swatchLabel}>{label}</span>
          </button>
        ))}
      </div>

      {/* Editing label */}
      <div className={styles.editingLabel}>
        Editing: <span>{activeDef.label}</span>
      </div>

      {/* Saturation / brightness canvas */}
      <div
        className={styles.canvasWrap}
        onMouseDown={handleCanvasDown}
        onTouchStart={handleCanvasDown}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
        <div
          className={styles.canvasCursor}
          style={{ left: cursorX, top: cursorY }}
        />
      </div>

      {/* Hue slider */}
      <div
        ref={hueRef}
        className={styles.hueSliderWrap}
        onMouseDown={handleHueDown}
        onTouchStart={handleHueDown}
      >
        <div className={styles.hueThumb} style={{ left: huePct }} />
      </div>

      {/* HEX / RGB inputs */}
      <div className={styles.inputRow}>
        <div className={styles.inputGroup}>
          <span className={styles.inputLabel}>Hex</span>
          <input
            className={styles.inputField}
            value={hexDraft !== null ? hexDraft.toUpperCase() : currentHex.toUpperCase()}
            onChange={(e) => handleHexChange(e.target.value)}
            onBlur={commitHexDraft}
            onKeyDown={(e) => { if (e.key === 'Enter') commitHexDraft() }}
          />
        </div>
        <div className={styles.inputGroup}>
          <span className={styles.inputLabel}>R</span>
          <input
            className={styles.inputField}
            type="number"
            min={0}
            max={255}
            value={rgb[0]}
            onChange={(e) => handleRgbInput(0, e.target.value)}
          />
        </div>
        <div className={styles.inputGroup}>
          <span className={styles.inputLabel}>G</span>
          <input
            className={styles.inputField}
            type="number"
            min={0}
            max={255}
            value={rgb[1]}
            onChange={(e) => handleRgbInput(1, e.target.value)}
          />
        </div>
        <div className={styles.inputGroup}>
          <span className={styles.inputLabel}>B</span>
          <input
            className={styles.inputField}
            type="number"
            min={0}
            max={255}
            value={rgb[2]}
            onChange={(e) => handleRgbInput(2, e.target.value)}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div className={styles.actions}>
        <button type="button" className={styles.actionBtn} onClick={handleReset}>
          <RotateCcw size={12} /> Reset
        </button>
      </div>
    </div>
  )
}
