export interface PersonaRegister {
  id: string;
  label: string;
  guidance: string;
}

export const PERSONA_REGISTERS: readonly PersonaRegister[] = [
  {
    id: "neutral",
    label: "Neutral",
    guidance:
      "They are simply both present in the scene with no prior history. Open on the situation itself; let the relationship be undefined and unweighted — a first encounter or incidental crossing, not a charged dynamic.",
  },
  {
    id: "canon",
    label: "Canon",
    guidance:
      "Honour the character's established world and situation. The persona belongs inside that canon — open on a moment that fits the character's own setting and stakes, with the relationship consistent with how this character would actually meet someone like the persona.",
  },
  {
    id: "au",
    label: "Alternate universe",
    guidance:
      "Reframe the meeting in an alternate setting away from the character's default canon (a different era, place, or genre) while keeping both figures themselves. The opening establishes the new frame quickly, then plays the two of them within it.",
  },
  {
    id: "romantic",
    label: "Romantic",
    guidance:
      "There is romantic or attractive charge between them. Open on a moment where that pull is live — tension, history, or fresh spark — without being explicit. The character's stance toward the persona carries warmth, wanting, or romantic friction.",
  },
  {
    id: "adversarial",
    label: "Adversarial",
    guidance:
      "They are at odds — rivals, opponents, or wary antagonists. Open on a moment of friction or confrontation where the character's posture toward the persona is guarded, competitive, or hostile, with real stakes between them.",
  },
];

export const DEFAULT_PERSONA_REGISTER = PERSONA_REGISTERS[0].id;

export function getPersonaRegister(id: string | null | undefined): PersonaRegister {
  return PERSONA_REGISTERS.find((r) => r.id === id) ?? PERSONA_REGISTERS[0];
}
