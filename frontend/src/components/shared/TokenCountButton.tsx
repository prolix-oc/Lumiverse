import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Hash } from 'lucide-react'
import clsx from 'clsx'
import { tokenizersApi } from '@/api/tokenizers'
import { useStore } from '@/store'
import { Spinner } from '@/components/shared/Spinner'
import styles from './TokenCountButton.module.css'

interface TokenCountButtonProps {
  text: string
  className?: string
  disabled?: boolean
}

export default function TokenCountButton({
  text,
  className,
  disabled = false,
}: TokenCountButtonProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor' })
  const activeProfileId = useStore((s) => s.activeProfileId)
  const profiles = useStore((s) => s.profiles)
  const [tokenCounting, setTokenCounting] = useState(false)
  const [tokenCount, setTokenCount] = useState<number | null>(null)
  const [tokenCountApprox, setTokenCountApprox] = useState(false)
  const latestTextRef = useRef(text)
  const requestIdRef = useRef(0)

  useEffect(() => {
    latestTextRef.current = text
    setTokenCounting(false)
    setTokenCount(null)
    setTokenCountApprox(false)
  }, [text])

  const setApproxCount = useCallback((value: string) => {
    setTokenCount(Math.ceil(value.length / 4))
    setTokenCountApprox(true)
  }, [])

  const handleCountTokens = useCallback(async () => {
    const textToCount = text
    if (!textToCount.trim()) return

    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId
    setTokenCounting(true)

    try {
      const profile = profiles.find((p) => p.id === activeProfileId) || profiles.find((p) => p.is_default)

      if (profile?.model) {
        const result = await tokenizersApi.countForModel(profile.model, textToCount)
        if (requestId !== requestIdRef.current || latestTextRef.current !== textToCount) return
        if (result.token_count != null) {
          setTokenCount(result.token_count)
          setTokenCountApprox(false)
        } else {
          setApproxCount(textToCount)
        }
      } else if (requestId === requestIdRef.current && latestTextRef.current === textToCount) {
        setApproxCount(textToCount)
      }
    } catch {
      if (requestId === requestIdRef.current && latestTextRef.current === textToCount) {
        setApproxCount(textToCount)
      }
    } finally {
      if (requestId === requestIdRef.current && latestTextRef.current === textToCount) {
        setTokenCounting(false)
      }
    }
  }, [activeProfileId, profiles, setApproxCount, text])

  return (
    <button
      type="button"
      className={clsx(styles.button, className)}
      onClick={handleCountTokens}
      disabled={tokenCounting || disabled || !text.trim()}
      title={t('countTokensTitle')}
    >
      {tokenCounting ? <Spinner size={11} fast /> : <Hash size={11} />}
      {tokenCount != null
        ? <span className={styles.value}>{tokenCountApprox ? '~' : ''}{t('tokenCount', { count: tokenCount.toLocaleString() })}</span>
        : t('countTokens')}
    </button>
  )
}
