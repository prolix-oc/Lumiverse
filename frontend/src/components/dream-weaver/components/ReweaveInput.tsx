import { useState, useRef } from 'react'
import { Send } from 'lucide-react'
import styles from './ReweaveInput.module.css'

interface ReweaveInputProps {
  loading: boolean
  onSubmit: (instruction: string) => void
}

export function ReweaveInput({ loading, onSubmit }: ReweaveInputProps) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed || loading) return
    onSubmit(trimmed)
    setValue('')
    ref.current?.removeAttribute('data-open')
  }

  return (
    <div className={styles.wrapper} ref={ref} data-reweave-input>
      <div className={styles.inner}>
        <input
          className={styles.input}
          type="text"
          placeholder="What should change?"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          disabled={loading}
        />
        <button
          className={styles.submit}
          onClick={handleSubmit}
          disabled={!value.trim() || loading}
        >
          <Send size={14} />
        </button>
      </div>
    </div>
  )
}
