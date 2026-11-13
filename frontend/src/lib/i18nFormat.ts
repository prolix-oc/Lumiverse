import i18n from '@/i18n'

/** Relative time label for chat cards and lists. */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diff = now - timestamp * 1000
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return i18n.t('time.justNow', { ns: 'common' })
  if (minutes < 60) return i18n.t('time.minutesAgo', { ns: 'common', count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return i18n.t('time.hoursAgo', { ns: 'common', count: hours })
  const days = Math.floor(hours / 24)
  if (days < 7) return i18n.t('time.daysAgo', { ns: 'common', count: days })
  return new Date(timestamp * 1000).toLocaleDateString()
}
