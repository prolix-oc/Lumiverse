import type { SpindleDockEdge } from 'lumiverse-spindle-types'

export type SpindleDockPanelDesktopSide = 'left' | 'right'

export function resolveDockPanelEdge(
  edge: SpindleDockEdge,
  desktopSide: SpindleDockPanelDesktopSide,
  isMobile: boolean,
): SpindleDockEdge {
  if (edge !== 'left' && edge !== 'right') {
    return edge
  }
  if (isMobile) {
    return 'top'
  }
  return desktopSide
}
