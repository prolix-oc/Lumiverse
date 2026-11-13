import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import DOMPurify from 'dompurify'
import { actionIcon } from './InputBarExtensionActions.icons'
import styles from './InputArea.module.css'
import {
  filterEnabledFrontendContributions,
  hasEnabledFrontendExtensionId,
} from '@/lib/spindle/frontend-extension-availability'

interface InputBarExtensionActionsProps {
  onClose: () => void
}

export default function InputBarExtensionActions({ onClose }: InputBarExtensionActionsProps) {
  const { t } = useTranslation('chat')
  const inputBarActions = useStore((s) => s.inputBarActions)
  const extensions = useStore((s) => s.extensions)

  const enabledActions = filterEnabledFrontendContributions(inputBarActions, extensions)
    .filter((action) => action.enabled)
  if (enabledActions.length === 0) return null

  const grouped = new Map<string, typeof enabledActions>()
  for (const action of enabledActions) {
    const list = grouped.get(action.extensionName) || []
    list.push(action)
    grouped.set(action.extensionName, list)
  }

  const handleClick = (action: (typeof enabledActions)[0]) => {
    if (!hasEnabledFrontendExtensionId(useStore.getState().extensions, action.extensionId)) return
    for (const handler of action.clickHandlers) {
      try { handler() } catch { /* no-op */ }
    }
    onClose()
  }

  return (
    <>
      <div className={styles.extrasDivider} />
      {Array.from(grouped.entries()).map(([extName, actions]) => (
        <div key={extName} className={styles.extrasSection}>
          <div className={styles.extrasExtHeader}>
            {extName}
            <span className={styles.extrasExtBadge}>{t('extension')}</span>
          </div>
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={styles.popRowBtn}
              onClick={() => handleClick(action)}
            >
              <span className={styles.personaMain}>
                {action.iconUrl && (
                  <img src={action.iconUrl} alt="" width={14} height={14} style={{ borderRadius: 2 }} />
                )}
                {action.iconSvg && !action.iconUrl && (
                  <span
                    style={{ display: 'inline-flex', width: 14, height: 14 }}
                    dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(action.iconSvg) }}
                  />
                )}
                {!action.iconUrl && !action.iconSvg && actionIcon(action.iconName)}
                <span className={styles.personaNameGroup}>
                  <span>{action.label}</span>
                  {action.subtitle && <span className={styles.personaTitle}>{action.subtitle}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      ))}
    </>
  )
}
