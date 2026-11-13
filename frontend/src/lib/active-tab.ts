import { frontendSessionId } from './frontend-session'

export class InactiveTabError extends Error {
  constructor() {
    super('Another tab is active. Reload this tab to take over.')
    this.name = 'InactiveTabError'
  }
}

export class ActiveTab {
  private readonly controller = new AbortController()
  readonly signal = this.controller.signal

  constructor(private readonly id: string, private readonly browser: Window = window) {}

  assertActive(): void {
    this.signal.throwIfAborted()
  }

  isEnforced(userId: string): boolean {
    return this.browser.localStorage.getItem(`lumiverse:allow-multiple-tabs:${userId}`) !== 'true'
  }

  setEnforced(userId: string, enforced: boolean): void {
    this.assertActive()
    const storage = this.browser.localStorage
    if (enforced) {
      storage.setItem(`lumiverse:active-tab:${userId}`, this.id)
      storage.removeItem(`lumiverse:allow-multiple-tabs:${userId}`)
    } else {
      storage.setItem(`lumiverse:allow-multiple-tabs:${userId}`, 'true')
    }
  }

  claim(userId: string): () => void {
    this.assertActive()
    const key = `lumiverse:active-tab:${userId}`
    const storage = this.browser.localStorage
    const checkOwner = () => {
      if (this.isEnforced(userId) && storage.getItem(key) !== this.id) this.controller.abort(new InactiveTabError())
    }
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea === storage && (event.key === key || event.key === `lumiverse:allow-multiple-tabs:${userId}` || event.key === null)) checkOwner()
    }
    const onVisible = () => {
      if (this.browser.document.visibilityState === 'visible') checkOwner()
    }

    // Read the current owner on notification so delayed events cannot displace a newer claim.
    storage.setItem(key, this.id)
    this.browser.addEventListener('storage', onStorage)
    this.browser.addEventListener('pageshow', checkOwner, true)
    this.browser.addEventListener('focus', checkOwner, true)
    this.browser.document.addEventListener('visibilitychange', onVisible, true)
    checkOwner()
    return () => {
      this.browser.removeEventListener('storage', onStorage)
      this.browser.removeEventListener('pageshow', checkOwner, true)
      this.browser.removeEventListener('focus', checkOwner, true)
      this.browser.document.removeEventListener('visibilitychange', onVisible, true)
    }
  }
}

export const activeTab = new ActiveTab(frontendSessionId)
