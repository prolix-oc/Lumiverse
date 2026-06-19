import { describe, expect, test } from "bun:test";
import { detectNicknameIntroductions } from "./entity-extractor";
import { refineHeuristicDetections } from "./detection-refiner";
import { isPlausibleAlias } from "./alias-validation";
import type { MemoryEntity } from "./types";

const now = Math.floor(Date.now() / 1000);

function makeEntity(name: string, entityType: MemoryEntity["entityType"], aliases: string[] = []): MemoryEntity {
  return {
    id: `${name}-${entityType}`,
    chatId: "chat-1",
    name,
    entityType,
    aliases,
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
  };
}

describe("detectNicknameIntroductions", () => {
  test("captures multiple nickname introductions in one chunk", () => {
    const knownEntities = [makeEntity("Melina Vale", "character"), makeEntity("Cassian Reed", "character")];
    const content = [
      "My name is Melina but everyone calls me Mel.",
      "Cassian Reed - or Cass, to his friends - was already waiting by the door.",
    ].join(" ");

    const aliases = detectNicknameIntroductions(content, knownEntities, ["Melina Vale", "Cassian Reed"]);

    expect(aliases).toEqual([
      { canonicalName: "Melina Vale", alias: "Mel" },
      { canonicalName: "Cassian Reed", alias: "Cass" },
    ]);
  });

  test("rejects common-word and phrase aliases from loose nickname patterns", () => {
    const knownEntities = [makeEntity("Melina Vale", "character")];
    const content = [
      "Melina Vale paused near the door.",
      "People called her Personal cost when the rumor spread.",
      "She was known as among the older guards, but no one used a real title.",
    ].join(" ");

    const aliases = detectNicknameIntroductions(content, knownEntities, ["Melina Vale"]);

    expect(aliases).toEqual([]);
  });
});

describe("isPlausibleAlias", () => {
  test("keeps name-like aliases and rejects prose fragments", () => {
    expect(isPlausibleAlias("Mel", "Melina Vale")).toBe(true);
    expect(isPlausibleAlias("The Iron Queen", "Melina Vale")).toBe(true);
    expect(isPlausibleAlias("Personal cost", "Melina Vale")).toBe(false);
    expect(isPlausibleAlias("among the nobility", "Melina Vale")).toBe(false);
    expect(isPlausibleAlias("Barely", "Melina Vale")).toBe(false);
  });
});

describe("refineHeuristicDetections", () => {
  test("promotes faction candidates using membership and asset cues", () => {
    const content = "Rhea joined the Azure Guard last winter. Two Azure Guard officers checked the convoy manifest before the Azure Guard patrol rolled out.";
    const refined = refineHeuristicDetections({
      content,
      knownEntities: [makeEntity("Rhea", "character")],
      characterNames: ["Rhea"],
      entities: [
        { name: "Rhea", type: "character", aliases: [], confidence: 1, mentionRole: "subject" },
        { name: "Azure Guard", type: "concept", aliases: [], confidence: 0.55, mentionRole: "present" },
      ],
      relationships: [],
      aliases: [],
    });

    const faction = refined.entities.find((entity) => entity.name === "Azure Guard");
    expect(faction?.type).toBe("faction");
    expect(faction && faction.confidence >= 0.82).toBe(true);
  });

  test("promotes event candidates using temporal and participation cues", () => {
    const content = "During the Black Tide Incident, Mara lost her brother. Survivors of the Black Tide Incident still gathered every winter to remember what happened.";
    const refined = refineHeuristicDetections({
      content,
      knownEntities: [makeEntity("Mara", "character")],
      characterNames: ["Mara"],
      entities: [
        { name: "Mara", type: "character", aliases: [], confidence: 1, mentionRole: "subject" },
        { name: "Black Tide Incident", type: "concept", aliases: [], confidence: 0.5, mentionRole: "referenced" },
      ],
      relationships: [],
      aliases: [],
    });

    const event = refined.entities.find((entity) => entity.name === "Black Tide Incident");
    expect(event?.type).toBe("event");
    expect(event && event.confidence >= 0.8).toBe(true);
  });

  test("merges nickname aliases into canonical character entities", () => {
    const refined = refineHeuristicDetections({
      content: "My name is Melina but everyone calls me Mel. Mel checked the latch twice.",
      knownEntities: [makeEntity("Melina Vale", "character")],
      characterNames: ["Melina Vale"],
      entities: [
        { name: "Mel", type: "concept", aliases: [], confidence: 0.5, mentionRole: "subject" },
      ],
      relationships: [],
      aliases: [{ canonicalName: "Melina Vale", alias: "Mel", evidence: "nickname introduction" }],
    });

    expect(refined.entities.find((entity) => entity.name === "Mel")).toBeUndefined();
    const canonical = refined.entities.find((entity) => entity.name === "Melina Vale");
    expect(canonical?.type).toBe("character");
    expect(canonical?.aliases).toContain("Mel");
  });

  test("drops invalid aliases before merging them into entities", () => {
    const refined = refineHeuristicDetections({
      content: "Melina Vale heard someone mention Personal cost, but nobody used it as her name.",
      knownEntities: [makeEntity("Melina Vale", "character")],
      characterNames: ["Melina Vale"],
      entities: [
        { name: "Melina Vale", type: "character", aliases: [], confidence: 1, mentionRole: "subject" },
      ],
      relationships: [],
      aliases: [{ canonicalName: "Melina Vale", alias: "Personal cost", evidence: "bad phrase" }],
      descriptionAliases: [{ canonicalName: "Melina Vale", alias: "among the crowd" }],
    });

    const canonical = refined.entities.find((entity) => entity.name === "Melina Vale");
    expect(canonical?.aliases).toEqual([]);
  });
});
