import type { MemoryEntityExtractionFilters } from "./entity-extraction-filters";
import type { EmotionalTag, EntityType, MentionRole, RelationType, SalienceResult } from "./types";

export interface HeuristicKnownEntity {
  name: string;
  entityType: EntityType;
  aliases: string[];
}

export interface HeuristicAnalysisInput {
  cleanContent: string;
  knownEntities: HeuristicKnownEntity[];
  characterNames: string[];
  entityWhitelist: string[];
  minConfidence: number;
  entityExtractionFilters: MemoryEntityExtractionFilters;
  descriptionAliases?: Array<{ canonicalName: string; alias: string }>;
  emotionalTags?: EmotionalTag[];
}

export interface HeuristicAnalysisOutput {
  salienceResult: SalienceResult;
  entities: Array<{
    name: string;
    type: EntityType;
    aliases: string[];
    confidence: number;
    mentionRole: MentionRole;
  }>;
  relationships: Array<{
    source: string;
    target: string;
    type: RelationType;
    label: string;
    sentiment: number;
    confidence: number;
  }>;
  aliases: Array<{ canonicalName: string; alias: string; evidence?: string }>;
  timings: {
    totalMs: number;
    salienceMs: number;
    entityMs: number;
    relationshipMs: number;
    aliasMs: number;
  };
}

export interface HeuristicWorkerRequest {
  type: "run";
  requestId: string;
  payload: HeuristicAnalysisInput;
}

export interface HeuristicWorkerSuccess {
  type: "result";
  requestId: string;
  result: HeuristicAnalysisOutput;
}

export interface HeuristicWorkerFailure {
  type: "error";
  requestId: string;
  error: string;
}

export type HeuristicWorkerResponse = HeuristicWorkerSuccess | HeuristicWorkerFailure;
