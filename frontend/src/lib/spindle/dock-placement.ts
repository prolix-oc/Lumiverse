import type { SpindleDockEdge } from 'lumiverse-spindle-types'

export type SpindleDockPanelDesktopSide = 'left' | 'right'

export function resolveDockPanelEdge(
  edge: SpindleDockEdge,
  desktopSide: SpindleDockPanelDesktopSide,
  isMobile: boolean,
  respectRequestedEdge = false,
): SpindleDockEdge {
  if (edge !== 'left' && edge !== 'right') {
    return edge
  }
  if (isMobile) {
    return 'top'
  }
  if (respectRequestedEdge) {
    return edge
  }
  return desktopSide
}
