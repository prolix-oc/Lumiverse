import { useStore } from '@/store'
import { useLumiaAvatar } from '@/lib/oocAvatarLookup'
import type { OOCStyleType } from '@/types/store'
import OOCSocialCard from './OOCSocialCard'
import OOCMarginNote from './OOCMarginNote'
import OOCWhisperBubble from './OOCWhisperBubble'
import OOCRawText from './OOCRawText'

interface OOCBlockProps {
  content: string
  name?: string
  index: number
}

export default function OOCBlock({ content, name, index }: OOCBlockProps) {
  const style = useStore((s) => s.lumiaOOCStyle) as OOCStyleType
  const { avatarUrl, displayName } = useLumiaAvatar(name)
  const isAlt = index % 2 === 1

  switch (style) {
    case 'margin':
      return <OOCMarginNote content={content} avatarUrl={avatarUrl} displayName={displayName} isAlt={isAlt} />
    case 'whisper':
      return <OOCWhisperBubble content={content} avatarUrl={avatarUrl} displayName={displayName} isAlt={isAlt} />
    case 'raw':
      return <OOCRawText content={content} />
    case 'social':
    default:
      return <OOCSocialCard content={content} avatarUrl={avatarUrl} displayName={displayName} />
  }
}
