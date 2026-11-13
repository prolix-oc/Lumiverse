// Import-free so native display and the server compare the same resolved fields.
export const MAX_REGEX_ACTION_SIGNATURE_LENGTH = 1_000_000;

export function regexActionSignature(action: {
  type: string;
  content: string;
  title?: string;
  subtitle?: string;
  effects?: ReadonlyArray<{ type: string; key?: string; value?: string; mode?: string; content?: string }>;
}): string {
  return JSON.stringify([
    action.type, action.content, action.title ?? "", action.subtitle ?? "",
    (Array.isArray(action.effects) ? action.effects : []).map(effect => effect?.type === "set_state"
      ? [effect.type, effect.key, effect.value]
      : effect?.type === "draft" ? [effect.type, effect.mode, effect.content] : [effect?.type]),
  ]);
}

export function isValidRegexActionSignature(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string" && value.length <= MAX_REGEX_ACTION_SIGNATURE_LENGTH;
}
