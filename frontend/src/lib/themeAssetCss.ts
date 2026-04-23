function shouldRewritePath(rawPath: string): boolean {
  if (!rawPath) return false
  const lowered = rawPath.toLowerCase()
  if (
    lowered.startsWith('http://') ||
    lowered.startsWith('https://') ||
    lowered.startsWith('data:') ||
    lowered.startsWith('blob:') ||
    lowered.startsWith('/') ||
    lowered.startsWith('#')
  ) {
    return false
  }
  return lowered.startsWith('./assets/') || lowered.startsWith('assets/')
}

export function toThemeAssetRelativePath(slug: string): string {
  const normalized = slug.replace(/^\.\//, '')
  return `./${normalized}`
}

export function rewriteThemeAssetUrls(css: string, bundleId: string | null | undefined): string {
  if (!bundleId) return css
  return css.replace(/url\(\s*(['"]?)([^)'"\s][^)'\"]*)\1\s*\)/gi, (full, quote: string, rawPath: string) => {
    const path = rawPath.trim()
    if (!shouldRewritePath(path)) return full
    const normalized = path.replace(/^\.\//, '')
    const encodedPath = normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/')
    const nextQuote = quote || '"'
    return `url(${nextQuote}/api/v1/theme-assets/bundles/${encodeURIComponent(bundleId)}/${encodedPath}${nextQuote})`
  })
}
