import clsx from 'clsx'
import { Link2, Mic, Volume2, Image as ImageIcon, type LucideIcon } from 'lucide-react'
import { providerColor } from './providerVisuals'
import styles from './ProviderIcon.module.css'

export type ProviderIconKind = 'llm' | 'imageGen' | 'tts' | 'stt'

const KIND_ICON: Record<ProviderIconKind, LucideIcon> = {
  llm: Link2,
  imageGen: ImageIcon,
  tts: Volume2,
  stt: Mic,
}

interface ProviderIconProps {
  kind: ProviderIconKind
  provider: string
  /** Fill the parent instead of rendering a `size`px chip. */
  fill?: boolean
  size?: number
  iconSize?: number
  className?: string
}

/** Provider chip: the kind's icon tinted with the provider's accent colour. */
export default function ProviderIcon({
  kind,
  provider,
  fill,
  size = 22,
  iconSize = 13,
  className,
}: ProviderIconProps) {
  const Icon = KIND_ICON[kind] ?? Link2
  const color = providerColor(provider)
  return (
    <span
      className={clsx(styles.icon, className)}
      style={{
        ...(fill ? { width: '100%', height: '100%' } : { width: size, height: size }),
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        color,
      }}
    >
      <Icon size={iconSize} />
    </span>
  )
}
