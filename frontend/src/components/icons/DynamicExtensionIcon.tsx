import { type CSSProperties, type ComponentType } from 'react'
import DOMPurify from 'dompurify'
import { Puzzle } from 'lucide-react'

export interface DynamicExtensionIconProps {
  iconSvg?: string | null
  iconUrl?: string | null
  size?: number
  strokeWidth?: number
  className?: string
  title?: string
  fallback?: ComponentType<{ size?: number; strokeWidth?: number; className?: string }>
}

const SAFE_DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/i

export function isSafeExtensionIconUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://lumiverse.local')
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return true
    if (parsed.protocol === 'data:') return SAFE_DATA_IMAGE.test(url.trim())
    return false
  } catch {
    return false
  }
}

export function sanitizeExtensionIconSvg(iconSvg: string): string {
  if (!iconSvg.trim()) return ''
  try {
    if (typeof DOMPurify.sanitize !== 'function') return ''
    return String(DOMPurify.sanitize(iconSvg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'style', 'foreignObject'],
      FORBID_ATTR: ['onload', 'onerror', 'onclick', 'onmouseover'],
    })).trim()
  } catch {
    return ''
  }
}

export function createDynamicExtensionIcon(source: {
  iconSvg?: string | null
  iconUrl?: string | null
}): ComponentType<{ size?: number; strokeWidth?: number; className?: string }> {
  function BoundDynamicExtensionIcon(props: { size?: number; strokeWidth?: number; className?: string }) {
    return <DynamicExtensionIcon iconSvg={source.iconSvg} iconUrl={source.iconUrl} {...props} />
  }
  BoundDynamicExtensionIcon.displayName = 'BoundDynamicExtensionIcon'
  return BoundDynamicExtensionIcon
}

export function DynamicExtensionIcon({
  iconSvg,
  iconUrl,
  size = 16,
  strokeWidth = 1.75,
  className,
  title,
  fallback: Fallback = Puzzle,
}: DynamicExtensionIconProps) {
  const boxStyle: CSSProperties = {
    display: 'inline-flex',
    width: size,
    height: size,
    flex: '0 0 auto',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  }

  if (iconUrl && isSafeExtensionIconUrl(iconUrl)) {
    return (
      <span className={className} style={boxStyle} role="img" aria-hidden={title ? undefined : true} aria-label={title}>
        <img src={iconUrl} alt="" width={size} height={size} draggable={false} />
      </span>
    )
  }

  const sanitized = iconSvg ? sanitizeExtensionIconSvg(iconSvg) : ''
  if (sanitized) {
    return (
      <span
        className={className}
        style={boxStyle}
        role="img"
        aria-hidden={title ? undefined : true}
        aria-label={title}
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    )
  }

  return <Fallback size={size} strokeWidth={strokeWidth} className={className} aria-hidden="true" />
}
