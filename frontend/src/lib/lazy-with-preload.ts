import { createElement, lazy, useState, type ComponentType, type ComponentProps } from 'react'

/** Preloading and rendering own the same import; neither mounts the component early. */
export function lazyWithPreload<T extends ComponentType<any>>(loader: () => Promise<{ default: T }>) {
  let pending: Promise<{ default: T }> | undefined
  let loaded: T | undefined
  const load = () => {
    if (!pending) {
      const request = loader().then(module => { loaded = module.default; return module })
      pending = request
      // A failed speculative request must not poison the first real open.
      void request.catch(() => { if (pending === request) pending = undefined })
    }
    return pending
  }
  const Deferred = lazy(load)
  function Panel(props: ComponentProps<T>) {
    // A warm first open renders synchronously. Keep the chosen type stable for
    // this mount so completing a cold import cannot remount a dirty editor.
    const [Component] = useState(() => (loaded ?? Deferred) as ComponentType<ComponentProps<T>>)
    return createElement(Component, props)
  }
  return Object.assign(Panel, { preload: load })
}
