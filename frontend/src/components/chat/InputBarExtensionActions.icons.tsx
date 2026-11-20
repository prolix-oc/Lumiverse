import { Waypoints } from 'lucide-react'

export function actionIcon(iconName: string | undefined) {
  if (iconName === 'waypoints') return <Waypoints size={14} />
  return null
}
