export function normalizeSpindleMessageMetadata(value: unknown, swipeCount: number): unknown {
  if (!value || typeof value !== "object") return value;
  const metadata = value as Record<string, unknown>;
  const contexts = metadata.preset_contexts;
  return Array.isArray(contexts) ? { ...metadata,
    preset_contexts: Array.from({ length: Math.max(1, swipeCount) }, (_, i) => contexts[i] ?? null),
  } : metadata;
}
