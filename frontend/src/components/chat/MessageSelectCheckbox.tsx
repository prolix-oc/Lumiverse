import { useTranslation } from 'react-i18next'
import styles from './MessageSelectCheckbox.module.css'

interface MessageSelectCheckboxProps {
  /** The message's position as the meta pill shows it, so the spoken name and
   *  the visible "#N" agree. */
  index: number
  name: string
  content: string
  checked: boolean
  onToggle?: (e: React.MouseEvent) => void
}

/** Enough of the message to tell two of them apart while tabbing, short enough
 *  that the checked state still arrives quickly. */
const PREVIEW_CHARS = 60

/**
 * The per-message selection control. Select mode used to be a click handler on
 * the message card plus an outline class, which leaves nothing for a screen
 * reader: no focus stop, no role, no checked state. A real checkbox carries all
 * three, and `aria-label` names it after the message it belongs to.
 */
export default function MessageSelectCheckbox({
  index, name, content, checked, onToggle,
}: MessageSelectCheckboxProps) {
  const { t } = useTranslation('chat')

  const preview = content.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS)
  const label = preview
    ? t('messageSelect.selectMessagePreview', { index, name, preview })
    : t('messageSelect.selectMessage', { index, name })

  return (
    <input
      type="checkbox"
      className={styles.checkbox}
      checked={checked}
      aria-label={label}
      onChange={(event) => {
        // One callback serves both the card's own click and this checkbox: it
        // reads only `shiftKey`, and React routes checkbox onChange through the
        // native click, so range selection still works from here.
        onToggle?.(event.nativeEvent as unknown as React.MouseEvent)
      }}
      // The card toggles selection on click too; without this the click would
      // bubble up and undo what the checkbox just did.
      onClick={(event) => event.stopPropagation()}
    />
  )
}
