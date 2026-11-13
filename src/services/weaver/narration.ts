export interface NarrationMode {
  id: string;
  label: string;
  guidance: string;
}

export const NARRATION_MODES: readonly NarrationMode[] = [
  {
    id: "first",
    label: "First person",
    guidance:
      'Write the narration in the FIRST PERSON as {{char}} — "I", "me", "my" — carried in {{char}}\'s own lens and idiolect, never a neutral camera. {{user}} is addressed in the second person ("you") where natural. *italics* may carry {{char}}\'s inner thought.',
  },
  {
    id: "second",
    label: "Second person",
    guidance:
      'Write the narration in the SECOND PERSON addressed to {{user}} — {{user}} is "you". Describe the scene and {{char}}\'s actions as they land on {{user}}; {{char}} is referred to by name or third person, {{user}} as "you". {{char}}\'s dialogue still sounds like {{char}}\'s own idiolect. *italics* may carry {{char}}\'s inner thought.',
  },
  {
    id: "third",
    label: "Third person",
    guidance:
      'Write the narration in the CLOSE THIRD PERSON following {{char}} — by name or "she/he/they" — but stay tight inside {{char}}\'s lens and idiolect (free indirect style), never a detached omniscient camera. {{user}} is addressed in the second person ("you") where natural. *italics* may carry {{char}}\'s inner thought.',
  },
];

export const DEFAULT_NARRATION_MODE = NARRATION_MODES[0].id;

export function getNarrationMode(id: string | null | undefined): NarrationMode {
  return NARRATION_MODES.find((m) => m.id === id) ?? NARRATION_MODES[0];
}

export function isNarrationModeId(id: unknown): id is string {
  return typeof id === "string" && NARRATION_MODES.some((m) => m.id === id);
}
