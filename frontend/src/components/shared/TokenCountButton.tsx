import { useTranslation } from 'react-i18next'
import { Hash } from 'lucide-react'
import clsx from 'clsx'
import { Spinner } from '@/components/shared/Spinner'
import { useTokenCounts } from '@/hooks/useTokenCounts'
import { useStore } from '@/store'

import styles from './TokenCountButton.module.css'
interface TokenCountButtonProps {
  text: string
  className?: string
  disabled?: boolean
  entryId?: string
  extensions?: unknown
}

export default function TokenCountButton({
  text,
  className,
  disabled = false,
  entryId,
  extensions,
}: TokenCountButtonProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'worldBookPanel.entryEditor' })
  const { count: tokenCount, approximate: tokenCountApprox, status, requestCount } = useTokenCounts({
    entryId,
    content: text,
    extensions,
    enabled: !disabled,
  }, { store: useStore })
  const tokenCounting = status === 'counting'

  return (
    <button
      type="button"
      className={clsx(styles.button, className)}
      onClick={requestCount}
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
