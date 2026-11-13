import type { NavigateFunction, NavigateOptions, To } from 'react-router'

let navigate: NavigateFunction | undefined

/** The entry point supplies navigation without making detached UI import routes. */
export function installAppNavigation(next: NavigateFunction): () => void {
  navigate = next
  return () => { if (navigate === next) navigate = undefined }
}

export function navigateApp(to: number): void | Promise<void>
export function navigateApp(to: To, options?: NavigateOptions): void | Promise<void>
export function navigateApp(to: To | number, options?: NavigateOptions): void | Promise<void> {
  if (!navigate) throw new Error('Application navigation is not initialized')
  return typeof to === 'number' ? navigate(to) : navigate(to, options)
}
