import { describe, expect, test } from "bun:test";

import { formatShadowPrompt } from "./shadow-formatter";
import type { CortexMemory, EntitySnapshot, RelationEdge } from "./types";

const components = {
  semantic: 0.8,
  salience: 0.7,
  recency: 0.4,
  reinforcement: 0,
  emotional: 0.1,
  entity: 0.2,
};

const rawMemory: CortexMemory = {
  source: "chunk",
  sourceId: "chunk-1",
  content: "Mara found the observatory door unlocked.",
  finalScore: 0.8,
  components,
  emotionalTags: [],
  entityNames: ["Mara"],
  messageRange: [21, 22],
  timeRange: [1, 2],
};

const sceneMemory: CortexMemory = {
  source: "consolidation",
  sourceId: "scene-1",
  content: "The Missing Map: Mara learned Tovin had sold the map, and they agreed to recover it together.",
  finalScore: 0.75,
  components,
  emotionalTags: ["betrayal"],
  entityNames: ["Mara", "Tovin"],
  messageRange: [5, 20],
  timeRange: [1, 2],
};

const entities: EntitySnapshot[] = [{
  id: "mara",
  name: "Mara",
  type: "character",
  status: "active",
  description: "An expedition leader",
  lastSeenAt: 2,
  mentionCount: 3,
  topFacts: ["Mara intends to recover the map"],
  emotionalProfile: {},
  relationships: [],
}];

const relationships: RelationEdge[] = [{
  sourceName: "Mara",
  targetName: "Tovin",
  type: "ally",
  label: "uneasy allies",
  strength: 0.6,
  sentiment: -0.2,
}];

const arc = "[Map Recovery] Mara and Tovin pursued the Syndicate while their trust remained damaged.";

describe("Cortex consolidation formatting", () => {
  test("narrative mode presents scenes and arcs as internal continuity", () => {
    const result = formatShadowPrompt(
      [rawMemory, sceneMemory], entities, relationships, arc,
      { mode: "shadow", tokenBudget: 2000 },
    ).text;

    expect(result).toContain("[Relevant continuity");
    expect(result).toContain("Scene continuity: The Missing Map");
    expect(result).toContain("[Story so far — internal continuity");
  });

  test("attributed mode includes evidence ranges and shared arc continuity", () => {
    const result = formatShadowPrompt(
      [sceneMemory], entities, relationships, arc,
      { mode: "attributed", tokenBudget: 2000, currentSpeakerName: "Mara" },
    ).text;

    expect(result).toContain("[messages #5–#20] Scene continuity:");
    expect(result).toContain("[Shared story continuity");
  });

  test("clinical mode labels scene and arc records explicitly", () => {
    const result = formatShadowPrompt(
      [sceneMemory], entities, relationships, arc,
      { mode: "clinical", tokenBudget: 2000 },
    ).text;

    expect(result).toContain("[SCENE CONTINUITY | #5–#20]");
    expect(result).toContain("[ARC CONTINUITY]");
  });

  test("minimal mode keeps only raw memory chunks", () => {
    const result = formatShadowPrompt(
      [rawMemory, sceneMemory], entities, relationships, arc,
      { mode: "minimal", tokenBudget: 2000 },
    ).text;

    expect(result).toBe(rawMemory.content);
    expect(result).not.toContain("Missing Map");
    expect(result).not.toContain("Map Recovery");
    expect(result).not.toContain("expedition leader");
  });
});
