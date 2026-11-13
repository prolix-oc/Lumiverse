import 'lumiverse-spindle-types'

// Keep the optional contract available until the next SDK release.
declare module 'lumiverse-spindle-types' {
  interface SpindleDisplayResolver { finalizeWithoutScripts?: boolean }
  interface SpindleDisplayResolveResult { processingState?: string }
  interface SpindleDisplayScriptsArgs { processingState?: string }
}
