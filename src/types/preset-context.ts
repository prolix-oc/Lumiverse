/** Request-time variables retained with a message, rather than read from the active preset. */
export interface MacroVariableSnapshot {
  local: Record<string, string>;
  global: Record<string, string>;
  chat: Record<string, string>;
  prompt_selections?: Record<string, string[]>;
  prompt_defaults?: Record<string, string>;
}

export interface MessagePresetContext {
  preset_id: string;
  variables?: Partial<MacroVariableSnapshot>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every(entry => typeof entry === "string");
}

export function readMessagePresetContext(extra: Record<string, unknown> | undefined, swipeId: number): MessagePresetContext | null {
  if (!Number.isSafeInteger(swipeId) || swipeId < 0) return null;
  const metadata = extra?.spindle_metadata;
  const contexts = isRecord(metadata) ? metadata.preset_contexts : undefined;
  const value: unknown = Array.isArray(contexts) ? contexts[swipeId] : undefined;
  if (!isRecord(value) || typeof value.preset_id !== "string" || !value.preset_id.trim()) return null;
  if (value.variables !== undefined) {
    if (!isRecord(value.variables)) return null;
    for (const key of ["local", "global", "chat", "prompt_defaults"]) {
      if (value.variables[key] !== undefined && !isStringRecord(value.variables[key])) return null;
    }
    const selections = value.variables.prompt_selections;
    if (selections !== undefined && (!isRecord(selections) || !Object.values(selections).every(
      entry => Array.isArray(entry) && entry.every(option => typeof option === "string"),
    ))) return null;
  }
  return value as unknown as MessagePresetContext;
}
