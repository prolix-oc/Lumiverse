import { useEffect, useRef, useState, type ChangeEventHandler, type FocusEventHandler, type InputHTMLAttributes, type KeyboardEventHandler } from 'react'

type NumericValue = number | null | undefined

export interface NumericInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> {
  value: NumericValue
  onChange: (value: number | null) => void
  allowEmpty?: boolean
  integer?: boolean
  /** Keep edits local until blur or Enter; Escape restores the latest value. */
  commitOnBlur?: boolean
}

function formatValue(value: NumericValue): string {
  return value == null ? '' : String(value)
}

function parseValue(raw: string, integer: boolean): number | null {
  if (raw.trim() === '') return null
  const parsed = integer ? parseInt(raw, 10) : Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

export default function NumericInput({
  value,
  onChange,
  allowEmpty = false,
  integer = false,
  commitOnBlur = false,
  onBlur,
  onFocus,
  onKeyDown,
  ...props
}: NumericInputProps) {
  const [draft, setDraft] = useState(() => formatValue(value))
  const isEditingRef = useRef(false)
  const focusValueRef = useRef('')

  useEffect(() => {
    if (!isEditingRef.current) {
      setDraft(formatValue(value))
    }
  }, [value])

  const handleFocus: FocusEventHandler<HTMLInputElement> = (event) => {
    isEditingRef.current = true
    focusValueRef.current = event.currentTarget.value
    onFocus?.(event)
  }

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const raw = event.target.value
    setDraft(raw)
    if (commitOnBlur) return
    if (raw === '') return
    const parsed = parseValue(raw, integer)
    if (parsed !== null) {
      onChange(parsed)
    }
  }

  const handleBlur: FocusEventHandler<HTMLInputElement> = (event) => {
    isEditingRef.current = false
    if (commitOnBlur) {
      const input = event.currentTarget
      const next = input.value === '' && allowEmpty ? null : input.valueAsNumber
      const valid = input.validity.valid && (next === null || (integer ? Number.isSafeInteger(next) : Number.isFinite(next)))
      const changed = input.value !== focusValueRef.current && next !== value
      const formatted = valid && changed ? formatValue(next) : formatValue(value)
      input.value = formatted
      setDraft(formatted)
      if (valid && changed) onChange(next)
      onBlur?.(event)
      return
    }
    if (draft === '') {
      if (allowEmpty) {
        onChange(null)
      } else {
        setDraft(formatValue(value))
      }
      onBlur?.(event)
      return
    }

    const parsed = parseValue(draft, integer)
    if (parsed === null) {
      setDraft(formatValue(value))
    } else {
      onChange(parsed)
    }
    onBlur?.(event)
  }

  const handleKeyDown: KeyboardEventHandler<HTMLInputElement> = (event) => {
    onKeyDown?.(event)
    if (!commitOnBlur || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.value = formatValue(value)
      setDraft(formatValue(value))
      event.currentTarget.blur()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  return (
    <input
      {...props}
      type="number"
      value={draft}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  )
}
