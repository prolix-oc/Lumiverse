import type { ComponentProps } from 'react'
import { registerHostSurfaceRenderer } from './host-surface-registry'
import {
  PRODUCTIVITY_HOST_SURFACES,
  ProductivityHostSurfaceRenderer as NativeProductivityHostSurfaceRenderer,
} from './productivity-host-contracts'

// Keep this registration module a React Refresh boundary, like the character
// and world-book renderers, rather than invalidating the entire loader graph.
export function ProductivityHostSurfaceRenderer(props: ComponentProps<typeof NativeProductivityHostSurfaceRenderer>) {
  return <NativeProductivityHostSurfaceRenderer {...props} />
}

const unregisterRenderers = PRODUCTIVITY_HOST_SURFACES.map(surfaceId =>
  registerHostSurfaceRenderer(surfaceId, (props, context) => (
    <ProductivityHostSurfaceRenderer surfaceId={surfaceId} props={props} context={context} />
  )),
)
if (import.meta.hot) import.meta.hot.dispose(() => unregisterRenderers.forEach(unregister => unregister()))
