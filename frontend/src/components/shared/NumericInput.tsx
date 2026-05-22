import { useEffect, useRef, useState, type ChangeEventHandler, type FocusEventHandler, type InputHTMLAttributes } from 'react'

type NumericValue = number | null | undefined

export interface NumericInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> {
  value: NumericValue
  onChange: (value: number | null) => void
  allowEmpty?: boolean
  integer?: boolean
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
  onBlur,
  onFocus,
  ...props
}: NumericInputProps) {
  const [draft, setDraft] = useState(() => formatValue(value))
  const isEditingRef = useRef(false)

  useEffect(() => {
    if (!isEditingRef.current) {
      setDraft(formatValue(value))
    }
  }, [value])

  const handleFocus: FocusEventHandler<HTMLInputElement> = (event) => {
    isEditingRef.current = true
    onFocus?.(event)
  }

  const handleChange: ChangeEventHandler<HTMLInputElement> = (event) => {
    const raw = event.target.value
    setDraft(raw)
    if (raw === '') return
    const parsed = parseValue(raw, integer)
    if (parsed !== null) {
      onChange(parsed)
    }
  }

  const handleBlur: FocusEventHandler<HTMLInputElement> = (event) => {
    isEditingRef.current = false
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

  return (
    <input
      {...props}
      type="number"
      value={draft}
      onFocus={handleFocus}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  )
}
