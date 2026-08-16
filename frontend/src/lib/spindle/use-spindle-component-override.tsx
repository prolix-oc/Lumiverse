import { useSyncExternalStore, type ComponentType, type ReactElement } from 'react'

import {
  getComponentOverrideEpoch,
  renderSpindleOverride,
  subscribeComponentOverrides,
  type SpindleOverrideHost,
} from './component-override-registry'

export function useSpindleComponentOverride<P extends object>(
  host: SpindleOverrideHost,
  DefaultComponent: ComponentType<P>,
  props: P,
): ReactElement {
  useSyncExternalStore(subscribeComponentOverrides, getComponentOverrideEpoch, getComponentOverrideEpoch)
  return renderSpindleOverride(host, DefaultComponent, props)
}
