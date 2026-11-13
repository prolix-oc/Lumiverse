import { useTranslation } from 'react-i18next'
import { COMPOSER_FORMATS, type ComposerFormat } from '@/lib/composerFormatting'
import styles from './ComposerFormattingBar.module.css'

const actions = [
  ['bold', 'B'],
  ['italic', 'I'],
  ['underline', 'U'],
  ['quotes', '"'],
  ['singleQuotes', "'"],
  ['parentheses', '( )'],
] as const

export default function ComposerFormattingBar({ onFormat }: { onFormat: (format: ComposerFormat) => void }) {
  const { t } = useTranslation('chat')
  return (
    <div className={styles.bar} data-composer-formatting="" role="group" aria-label={t('input.formatting.label')}>
      {actions.map(([format, glyph]) => (
        <button
          key={format}
          type="button"
          className={`${styles.button} ${styles[format]}`}
          aria-label={t(`input.formatting.${format}`)}
          title={`${t(`input.formatting.${format}`)} (${COMPOSER_FORMATS[format].join('…')})`}
          // Keep the textarea selection and keyboard through the mouse event
          // synthesized after a tap. Canceling pointerdown also cancels taps
          // in some WebKit versions; leave native touch scrolling intact.
          onMouseDown={(event) => { if (event.button === 0) event.preventDefault() }}
          onFocus={(event) => event.currentTarget.scrollIntoView({ block: 'nearest', inline: 'nearest' })}
          onClick={() => onFormat(format)}
        >
          <span aria-hidden="true">
            {format === 'parentheses' ? <><span>(</span><span>)</span></> : glyph}
          </span>
        </button>
      ))}
    </div>
  )
}
