import { Activity, useState, type ReactNode } from 'react'

/** Retain a visited panel's DOM/state while pausing its effects when inactive. */
export function ActivityPanel({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active)
  // Avoid rendering every settings panel on first open. A newly active panel
  // joins the retained tree immediately, before its children are committed.
  if (active && !visited) setVisited(true)
  if (!active && !visited) return null

  return <Activity mode={active ? 'visible' : 'hidden'}>{children}</Activity>
}
