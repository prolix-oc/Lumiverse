import { refineHeuristicDetections } from "./detection-refiner";
import { extractEntitiesHeuristic, detectNicknameIntroductions } from "./entity-extractor";
import type { HeuristicAnalysisInput, HeuristicAnalysisOutput } from "./heuristic-runtime";
import { extractRelationshipsHeuristic } from "./relationship-extractor";
import { scoreChunkHeuristic } from "./salience-heuristic";
import type { MemoryEntity } from "./types";

function inflateKnownEntities(input: HeuristicAnalysisInput): MemoryEntity[] {
  const now = Math.floor(Date.now() / 1000);
  return input.knownEntities.map((entity, index) => ({
    id: `worker-${index}-${entity.name}`,
    chatId: "worker",
    name: entity.name,
    entityType: entity.entityType,
    aliases: entity.aliases,
    description: "",
    firstSeenChunkId: null,
    lastSeenChunkId: null,
    firstSeenAt: null,
    lastSeenAt: null,
    mentionCount: 0,
    salienceAvg: 0,
    status: "active",
    statusChangedAt: null,
    facts: [],
    emotionalValence: {},
    metadata: {},
    createdAt: now,
    updatedAt: now,
    factExtractionStatus: "never",
    factExtractionLastAttempt: null,
    salienceBreakdown: {
      mentionComponent: 0,
      arcComponent: 0,
      graphComponent: 0,
      frequencyFloor: 0,
      total: 0,
    },
    lastMentionTimestamp: null,
    recentMentionCount: 0,
    confidence: "confirmed",
    userEditedAt: null,
    saliencePeak: 0,
  }));
}

export function runHeuristicAnalysis(input: HeuristicAnalysisInput): HeuristicAnalysisOutput {
  const totalStart = performance.now();
  const knownEntities = inflateKnownEntities(input);

  const salienceStart = performance.now();
  const salienceResult = scoreChunkHeuristic(input.cleanContent);
  const salienceMs = performance.now() - salienceStart;

  const entityStart = performance.now();
  const rawEntities = extractEntitiesHeuristic(
    input.cleanContent,
    knownEntities,
    input.characterNames,
    input.entityWhitelist,
    input.minConfidence,
    input.entityExtractionFilters,
  );
  const entityMs = performance.now() - entityStart;

  const relationshipStart = performance.now();
  const entityNamesInChunk = rawEntities.map((entity) => entity.name);
  const rawRelationships = extractRelationshipsHeuristic(
    input.cleanContent,
    entityNamesInChunk,
    input.emotionalTags ?? salienceResult.emotionalTags,
  );
  const relationshipMs = performance.now() - relationshipStart;

  const aliasStart = performance.now();
  const rawAliases = detectNicknameIntroductions(
    input.cleanContent,
    knownEntities,
    input.characterNames,
  );
  const aliasMs = performance.now() - aliasStart;

  const refined = refineHeuristicDetections({
    content: input.cleanContent,
    knownEntities,
    characterNames: input.characterNames,
    entities: rawEntities,
    relationships: rawRelationships,
    aliases: rawAliases.map((alias) => ({ ...alias, evidence: "nickname introduction" })),
    descriptionAliases: input.descriptionAliases,
  });

  return {
    salienceResult,
    entities: refined.entities,
    relationships: refined.relationships.map((relationship) => ({
      ...relationship,
      confidence: relationship.confidence ?? 1,
    })),
    aliases: refined.aliases,
    timings: {
      totalMs: performance.now() - totalStart,
      salienceMs,
      entityMs,
      relationshipMs,
      aliasMs,
    },
  };
}
