import { eventBus } from "../ws/bus";
import { EventType } from "../ws/events";

export const FRONTEND_RUNTIME_CAPABILITIES = ["message_tag_interceptor"] as const;

export type FrontendRuntimeCapability =
  (typeof FRONTEND_RUNTIME_CAPABILITIES)[number];

const capabilitiesByExtension = new Map<string, Set<FrontendRuntimeCapability>>();

export function isFrontendRuntimeCapability(
  value: string,
): value is FrontendRuntimeCapability {
  return (FRONTEND_RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

export function registerFrontendRuntimeCapability(
  extensionId: string,
  capability: FrontendRuntimeCapability,
): void {
  const capabilities = capabilitiesByExtension.get(extensionId) ?? new Set();
  if (capabilities.has(capability)) return;
  capabilities.add(capability);
  capabilitiesByExtension.set(extensionId, capabilities);
  eventBus.emit(EventType.SPINDLE_FRONTEND_RUNTIME_CAPABILITY_CHANGED, {
    action: "registered",
    extensionId,
    capability,
  });
}

export function unregisterFrontendRuntimeCapability(
  extensionId: string,
  capability: FrontendRuntimeCapability,
): void {
  const capabilities = capabilitiesByExtension.get(extensionId);
  if (!capabilities?.delete(capability)) return;
  if (capabilities.size === 0) capabilitiesByExtension.delete(extensionId);
  eventBus.emit(EventType.SPINDLE_FRONTEND_RUNTIME_CAPABILITY_CHANGED, {
    action: "unregistered",
    extensionId,
    capability,
  });
}

export function clearFrontendRuntimeCapabilities(extensionId: string): void {
  const capabilities = capabilitiesByExtension.get(extensionId);
  if (!capabilities) return;
  capabilitiesByExtension.delete(extensionId);
  for (const capability of capabilities) {
    eventBus.emit(EventType.SPINDLE_FRONTEND_RUNTIME_CAPABILITY_CHANGED, {
      action: "unregistered",
      extensionId,
      capability,
    });
  }
}

export function getFrontendRuntimeCapabilities(
  extensionId: string,
): FrontendRuntimeCapability[] {
  return [...(capabilitiesByExtension.get(extensionId) ?? [])];
}

export function resetFrontendRuntimeCapabilitiesForTests(): void {
  capabilitiesByExtension.clear();
}
