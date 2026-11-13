export type CouncilView = 'setup' | 'feedback' | 'ooc'

export const COUNCIL_TAB_ALIASES: Record<string, CouncilView> = {
  ooc: 'ooc',
  feedback: 'feedback',
}

export function councilViewForTab(tabId: string): CouncilView | undefined {
  return Object.hasOwn(COUNCIL_TAB_ALIASES, tabId) ? COUNCIL_TAB_ALIASES[tabId] : undefined
}

export function resolveCouncilTabId(tabId: string): string {
  return councilViewForTab(tabId) ? 'council' : tabId
}
