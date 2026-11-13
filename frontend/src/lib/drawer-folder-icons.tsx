import { createElement, type ComponentType } from 'react'
import {
  BookOpen,
  Boxes,
  Brain,
  Code2,
  Database,
  Folder,
  Gamepad2,
  Image,
  MessageSquare,
  Palette,
  Sparkles,
  Wrench,
  Zap,
} from 'lucide-react'
import type { DrawerCustomIconData } from '@/types/store'
import { sanitizeDrawerCustomIconData } from '@/lib/drawer-custom-icon'

interface FolderIconProps {
  size?: number
  strokeWidth?: number
  className?: string
}

export interface DrawerFolderIconOption {
  id: string
  label: string
  Icon: ComponentType<FolderIconProps>
}

export const DRAWER_FOLDER_ICON_OPTIONS: DrawerFolderIconOption[] = [
  { id: 'folder', label: 'Folder', Icon: Folder },
  { id: 'brain', label: 'Brain', Icon: Brain },
  { id: 'book', label: 'Book', Icon: BookOpen },
  { id: 'message', label: 'Chat', Icon: MessageSquare },
  { id: 'database', label: 'Database', Icon: Database },
  { id: 'palette', label: 'Palette', Icon: Palette },
  { id: 'image', label: 'Image', Icon: Image },
  { id: 'code', label: 'Code', Icon: Code2 },
  { id: 'tools', label: 'Tools', Icon: Wrench },
  { id: 'game', label: 'Game', Icon: Gamepad2 },
  { id: 'boxes', label: 'Boxes', Icon: Boxes },
  { id: 'sparkles', label: 'Sparkles', Icon: Sparkles },
  { id: 'zap', label: 'Zap', Icon: Zap },
]

const DRAWER_FOLDER_ICON_BY_ID = new Map(
  DRAWER_FOLDER_ICON_OPTIONS.map((option) => [option.id, option.Icon] as const),
)

export function getDrawerFolderIcon(icon?: string) {
  return (icon && DRAWER_FOLDER_ICON_BY_ID.get(icon)) || Folder
}

export function DrawerFolderIcon({
  icon,
  customIcon,
  size = 18,
  strokeWidth = 1.7,
  className,
}: FolderIconProps & { icon?: string; customIcon?: DrawerCustomIconData }) {
  const safeCustomIcon = sanitizeDrawerCustomIconData(customIcon)
  if (!safeCustomIcon) {
    const Icon = getDrawerFolderIcon(icon)
    // eslint-disable-next-line react-hooks/static-components -- The lookup returns a module-level Lucide component; it never creates a component.
    return <Icon size={size} strokeWidth={strokeWidth} className={className} />
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={safeCustomIcon.viewBox}
      className={className}
      aria-hidden="true"
      focusable="false"
      {...safeCustomIcon.attrs}
    >
      {safeCustomIcon.elements.map((element, index) => createElement(element.tag, {
        ...element.attrs,
        key: `${element.tag}-${index}`,
      }))}
    </svg>
  )
}
