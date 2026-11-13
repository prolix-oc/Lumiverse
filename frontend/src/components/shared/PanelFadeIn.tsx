import type { ReactNode } from 'react'

interface PanelFadeInProps {
  children: ReactNode
  className?: string
}

export default function PanelFadeIn({ children, className }: PanelFadeInProps) {
  return (
    <div className={`lumiverse-panel-enter${className ? ` ${className}` : ''}`}>
      {children}
    </div>
  )
}
