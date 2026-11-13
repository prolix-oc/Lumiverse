// Store construction must not evaluate the extension UI graph: the loader and
// its native renderers consume the completed store. Lifecycle actions already
// await these operations, so load that graph only when it is needed.
export async function loadFrontendExtension(...args: Parameters<typeof import('./loader').loadFrontendExtension>) {
  const loader = await import('./loader')
  return loader.loadFrontendExtension(...args)
}

export async function unloadFrontendExtension(...args: Parameters<typeof import('./loader').unloadFrontendExtension>) {
  const loader = await import('./loader')
  return loader.unloadFrontendExtension(...args)
}
