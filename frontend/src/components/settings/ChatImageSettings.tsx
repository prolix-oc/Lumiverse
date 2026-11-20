import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { DEFAULT_CHAT_IMAGE_TARGETS } from '@/lib/chatImagePresentation'
import { useStore } from '@/store'
import styles from './ChatImageSettings.module.css'

export default function ChatImageSettings() {
  const { t } = useTranslation('settings', { keyPrefix: 'chat.inlineImages' })
  const size = useStore(s => s.chatImageSize)
  const alignment = useStore(s => s.chatImageAlignment)
  const targets = useStore(s => s.chatImageTargets ?? DEFAULT_CHAT_IMAGE_TARGETS)
  const setSetting = useStore(s => s.setSetting)
  const id = useId()
  return (
    <div className={styles.panel}>
      <span id={id + '-size'} className={styles.label}>{t('size')}</span>
      <p id={id + '-hint'} className={styles.hint}>{t('hint')}</p>
      <div className={styles.presets} role="group" aria-labelledby={id + '-size'} aria-describedby={id + '-hint'}>
        {(['default', '100', '75', '50'] as const).map(preset => (
          <button
            key={preset}
            type="button"
            className={clsx(styles.preset, size === preset && styles.selected)}
            aria-pressed={size === preset}
            onClick={() => setSetting('chatImageSize', preset)}
          >
            <span className={styles.preview} aria-hidden="true">
              <span className={styles.image} style={{ width: preset === 'default' ? '32%' : preset + '%', height: preset === 'default' ? '55%' : preset + '%' }} />
            </span>
            <span>{preset === 'default' ? t('default') : preset + '% × ' + preset + '%'}</span>
          </button>
        ))}
      </div>
      <fieldset className={styles.targets}>
        <legend className={styles.label}>{t('applyTo')}</legend>
        <div className={styles.targetOptions}>
          {(['markdown', 'html', 'attachments'] as const).map(target => (
            <label key={target} className={styles.target}>
              <input
                type="checkbox"
                checked={targets[target]}
                onChange={event => setSetting('chatImageTargets', { ...targets, [target]: event.currentTarget.checked })}
              />
              {t(target)}
            </label>
          ))}
        </div>
      </fieldset>
      <span id={id + '-alignment'} className={styles.label}>{t('alignment')}</span>
      <div className={styles.alignments} role="group" aria-labelledby={id + '-alignment'}>
        {(['left', 'center', 'right'] as const).map(value => (
          <button
            key={value}
            type="button"
            className={clsx(styles.alignment, alignment === value && styles.selected)}
            aria-pressed={alignment === value}
            onClick={() => setSetting('chatImageAlignment', value)}
          >{t(value)}</button>
        ))}
      </div>
    </div>
  )
}
