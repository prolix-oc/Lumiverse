import { useMemo } from 'react'
import { sanitizeRichHtml } from '@/lib/richHtmlSanitizer'
import styles from './OOCStyles.module.css'

interface OOCRawTextProps {
  content: string
}

export default function OOCRawText({ content }: OOCRawTextProps) {
  const safeContent = useMemo(() => sanitizeRichHtml(content), [content])

  return (
    <span
      className={styles.raw}
      dangerouslySetInnerHTML={{ __html: safeContent }}
    />
  )
}
