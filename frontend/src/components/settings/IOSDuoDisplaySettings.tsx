import { useTranslation } from 'react-i18next'
import { Toggle } from '@/components/shared/Toggle'
import { useIOSLayoutSnapshot } from '@/hooks/useIOSDuoLayout'
import { isIOSFoldable } from '@/lib/ios-duo-layout'
import type { DrawerSettings } from '@/types/store'

export default function IOSDuoDisplaySettings({ settings, onChange }: {
  settings: DrawerSettings
  onChange: (patch: Partial<DrawerSettings>) => void
}) {
  const { t } = useTranslation('settings')
  const snapshot = useIOSLayoutSnapshot()
  if (!isIOSFoldable(snapshot)) return null
  return <Toggle.Checkbox
    checked={settings.duoAlwaysOpen !== false}
    onChange={(checked) => onChange({ duoAlwaysOpen: checked })}
    label={t('display.drawer.duoAlwaysOpen')}
    hint={t('display.drawer.duoAlwaysOpenHint')}
  />
}
