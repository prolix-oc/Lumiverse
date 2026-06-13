import type { DynamicQuestionGateCriterion } from "../dynamic-question-gate";

export interface WeaverImportActionDef {
  id: string;
  artifact: string;
  outcome: "session" | "book";
  targetBuildType?: string;
  seedType?: string;
  bindSource?: boolean;
  readingCue?: string;
  bookWork?: {
    instruction: string;
    gateCriteria: readonly DynamicQuestionGateCriterion[];
  };
  order: number;
}

const ENRICH_GATE_CRITERIA: readonly DynamicQuestionGateCriterion[] = [
  {
    key: "grounded",
    label: "Grounded",
    description:
      "Everything added is supported by or directly extends what the book's entries establish; nothing contradicts them or arrives from outside the book.",
  },
  {
    key: "preserving",
    label: "Preserving",
    description:
      "Every claim the original entry made survives in substance. Nothing was rewritten away, weakened, or replaced by a different idea.",
  },
  {
    key: "playable",
    label: "Playable",
    description:
      "The additions are concrete, scene-usable specifics — who, where, what it looks and sounds like, what it costs — not abstract elaboration or filler prose.",
  },
];

const ENRICH_INSTRUCTION = `Deepen ONE worldbook entry into a richer one. The original entry's claims are established canon: every one of them survives in substance — you extend the entry, you never rewrite it into a different idea. Add the playable specificity it is missing: concrete detail a narrator could use in a scene (who is involved, where it sits, what it looks and sounds like, what it costs or threatens). Stay strictly inside what the book's other entries establish; extend, never contradict, and never import material from outside the book. Output the enriched entry content only — no headers, no commentary.`;

export const IMPORT_ACTIONS: readonly WeaverImportActionDef[] = [
  {
    id: "rebuild",
    artifact: "card",
    outcome: "session",
    targetBuildType: "character",
    seedType: "card",
    readingCue:
      "a single persona: one person who speaks as themselves and owns the card's voice",
    order: 1,
  },
  {
    id: "world_treatment",
    artifact: "card",
    outcome: "session",
    targetBuildType: "world",
    seedType: "card",
    readingCue:
      "a narrator or scenario card: it runs a place or situation, sets scenes and voices many people, and no single persona owns the voice",
    order: 2,
  },
  {
    id: "enrich",
    artifact: "worldbook",
    outcome: "book",
    bookWork: { instruction: ENRICH_INSTRUCTION, gateCriteria: ENRICH_GATE_CRITERIA },
    order: 1,
  },
  {
    id: "generate_character",
    artifact: "worldbook",
    outcome: "session",
    targetBuildType: "character",
    seedType: "worldbook",
    bindSource: true,
    order: 2,
  },
  {
    id: "build_world",
    artifact: "worldbook",
    outcome: "session",
    targetBuildType: "world",
    seedType: "worldbook",
    bindSource: true,
    order: 3,
  },
  {
    id: "store",
    artifact: "worldbook",
    outcome: "book",
    order: 4,
  },
];

export function getImportAction(id: string): WeaverImportActionDef | undefined {
  return IMPORT_ACTIONS.find((a) => a.id === id);
}

export function importActionsFor(artifact: string): WeaverImportActionDef[] {
  return IMPORT_ACTIONS.filter((a) => a.artifact === artifact).sort((a, b) => a.order - b.order);
}

export function readingActionsFor(artifact: string): WeaverImportActionDef[] {
  return importActionsFor(artifact).filter((a) => a.readingCue);
}
