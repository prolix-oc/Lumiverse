let currentExtensionLoad: Promise<void> | null = null

export function shareExtensionLoad(run: () => Promise<void>): Promise<void> {
  if (currentExtensionLoad) return currentExtensionLoad

  const load = run().finally(() => {
    if (currentExtensionLoad === load) currentExtensionLoad = null
  })
  currentExtensionLoad = load
  return load
}
