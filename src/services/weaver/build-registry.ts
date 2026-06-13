import type { SpineSlot, SynthesisGroupDef } from "./slots";
import type { WeaverFieldDef } from "./fields";
import type { GateCriterion } from "./gate";
import type { FieldGateCriterion } from "./field-gate";
import type { DynamicQuestionGateCriterion } from "./dynamic-question-gate";
import type { WeaverBibleSpine } from "../../types/weaver";
import { CHARACTER_REGISTRY } from "./registries/character";
import { WORLD_REGISTRY } from "./registries/world";

export interface WeaverSubjectLexicon {
  noun: string;
  deepeningLine: string;
  extractionConditionalBlock: string;
  subPartExamples: string;
  causalLinkExamples: string;
  coherentPhrase: string;
  briefInstruction: string;
}

export interface WeaverAgencyMaterial {
  agenda: string;
  holds: string[];
}

export interface WeaverGovernanceContext {
  hasNpcBook?: boolean;
  agency?: WeaverAgencyMaterial;
}

export interface WeaverAgencyRegistry {
  slotId: string;
  agendaPart: string;
  holdsPart: string;
  dataEntryComment: string;
  governanceComment: string;
}

export interface WeaverDynamicWeaveRegistry {
  instruction: string;
  gateCriteria: readonly DynamicQuestionGateCriterion[];
}

export interface WeaverPeopleLexicon {
  harvestInstruction: string;
  proposeInstruction: string;
  extraInstruction: string;
  questionInstruction: string;
  weaveInstruction: string;
}

export interface WeaverPeopleRegistry {
  bookRole: string;
  promoteTo: string;
  associationRole: string;
  proposeCount: number;
  namedQuestionTarget: number;
  questionGateCriteria: readonly DynamicQuestionGateCriterion[];
  weaveGateCriteria: readonly DynamicQuestionGateCriterion[];
  lexicon: WeaverPeopleLexicon;
}

export interface WeaverBuildRegistry {
  buildType: string;
  subject: WeaverSubjectLexicon;
  slots: readonly SpineSlot[];
  synthesisGroups: readonly SynthesisGroupDef[];
  fieldDefs: readonly WeaverFieldDef[];
  bibleGateCriteria: readonly GateCriterion[];
  fieldGateCriteria: readonly FieldGateCriterion[];
  questionGateCriteria: readonly DynamicQuestionGateCriterion[];
  dynamicWeave: WeaverDynamicWeaveRegistry;
  voiceSlot: string;
  nameSlot: string;
  governanceEntries(
    spine: WeaverBibleSpine,
    ctx?: WeaverGovernanceContext,
  ): Record<string, unknown>[];
  reanchorEntry(name: string, spine: WeaverBibleSpine): Record<string, unknown>;
  extensionSlots: readonly string[];
  finalizeBookRoles: readonly string[];
  people?: WeaverPeopleRegistry;
  agency?: WeaverAgencyRegistry;
  creatorNotes: string;
}

const REGISTRIES: readonly WeaverBuildRegistry[] = [CHARACTER_REGISTRY, WORLD_REGISTRY];

export function getBuildRegistry(buildType: string): WeaverBuildRegistry {
  return REGISTRIES.find((r) => r.buildType === buildType) ?? CHARACTER_REGISTRY;
}
