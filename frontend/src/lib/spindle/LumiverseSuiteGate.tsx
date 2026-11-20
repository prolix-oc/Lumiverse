import type { ReactNode } from 'react'
import { useStore } from '@/store'
import { hasEnabledFrontendExtension, hasEnabledFrontendExtensionId } from './frontend-extension-availability'

/** Keep Suite surfaces, their effects, and their overrides unmounted until available. */
export function LumiverseSuiteGate({ children, ownerExtensionId }: { children: ReactNode; ownerExtensionId?: string }) {
  const available = useStore((state) => hasEnabledFrontendExtension(state.extensions, 'lumiverse_suite')
    && (ownerExtensionId === undefined || hasEnabledFrontendExtensionId(state.extensions, ownerExtensionId)))
  return available ? children : null
}
