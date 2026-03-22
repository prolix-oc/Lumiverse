import styles from './OOCStyles.module.css'

interface OOCRawTextProps {
  content: string
}

export default function OOCRawText({ content }: OOCRawTextProps) {
  return (
    <span
      className={styles.raw}
      dangerouslySetInnerHTML={{ __html: content }}
    />
  )
}
