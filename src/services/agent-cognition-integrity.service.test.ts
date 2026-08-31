import { describe, expect, test } from "bun:test";
import type { AgenticReadinessVectorV1 } from "../types/agent-runtime-decision";
import {
  COGNITION_LIMITS_V1,
  CognitionIntegrityRegistry,
  CognitionRepairError,
  applyCognitionReadinessV1,
  encodeAgenticReadinessVectorV1,
  hashAgenticReadinessVectorV1,
  normalizeImportedCognition,
  normalizeLegacyCognition,
  validateCognitionIntegrity,
} from "./agent-cognition-integrity.service";
import type { CognitionIntegritySnapshotV1, CognitionRepairCode, CognitionRepairRequestV1 } from "./agent-cognition-integrity.service";

function snapshot(overrides: Partial<CognitionIntegritySnapshotV1> = {}): CognitionIntegritySnapshotV1 {
  return {
    userId: "user-1",
    presetId: "preset-1",
    cognition: {
      version: 1,
      policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
      templates: [],
    },
    source: "local",
    ...overrides,
  };
}

function repairRequest(overrides: Partial<CognitionRepairRequestV1> = {}): CognitionRepairRequestV1 {
  return {
    authenticatedUserId: "user-1",
    ownerUserId: "user-1",
    explicitAction: "repair_cognition",
    acknowledgement: true,
    expectedScopeRevision: 1,
    ...overrides,
  };
}

function readiness(overrides: Record<string, unknown> = {}): AgenticReadinessVectorV1 {
  return {
    schemaEpoch: 1,
    runtimeEpoch: 2,
    reconciliationEpoch: 3,
    archiveRegistryVersion: 4,
    isolateHealthEpoch: 5,
    publicationStoreHealthEpoch: 6,
    providerCapabilityRevision: 7,
    configRevision: 8,
    bindingRevision: 9,
    concreteConnectionRevision: 10,
    targetRevision: 11,
    inputRevisionDigest: "input-digest",
    cognitionRevision: 12,
    killSwitchState: "auto",
    ready: true,
    reasons: [],
    ...overrides,
  } as unknown as AgenticReadinessVectorV1;
}

describe("agent cognition integrity", () => {
  test("quarantines invalid graph, stale Loom source, predicate limits, and imported authority", () => {
    const cases: Array<[string, CognitionIntegritySnapshotV1, CognitionRepairCode]> = [
      ["invalid cognition", snapshot({ cognition: [] }), "cognition_invalid"],
      ["missing block revision", snapshot({ blockRefs: [{ blockId: "block-1", expectedRevision: 1, actualRevision: null }] }), "cognition_missing_block_revision"],
      ["predicate cap", snapshot({ predicateStats: { depth: COGNITION_LIMITS_V1.maxPredicateDepth + 1 } }), "cognition_predicate_limit_exceeded"],
      ["repair required", snapshot({ repairRequired: true }), "cognition_repair_required"],
      ["foreign authority blocked", snapshot({ source: "foreign" }), "cognition_foreign_authority_blocked"],
      ["legacy review required", snapshot({ source: "legacy" }), "cognition_import_review_required"],
    ];
    for (const [label, input, code] of cases) {
      const result = validateCognitionIntegrity(input);
      expect(result.repairCode, label).toBe(code);
      expect(result.valid, label).toBe(false);
      expect(result.agenticAllowed, label).toBe(false);
      expect(result.responseAvailable, label).toBe(true);
      expect(result.preserved, label).toBe(true);
    }
  });

  test("freezes Loom revisions and parser caps into stable repair reasons", () => {
    const graph = {
      version: 1,
      policies: { workPolicy: [{ blockId: "block-1", expectedPresetRevision: 1, expectedBlockRevision: 1, promptOrder: 0 }], workspaceUsage: [], completionCriteria: [], renderPolicy: [] },
      templates: [],
    };
    const missingBlock = validateCognitionIntegrity(snapshot({
      cognition: graph,
      cognitionSource: { presetRevision: 1, blocks: [{ blockId: "block-1", revision: 2, promptOrder: 0 }] },
    }));
    expect(missingBlock.repairCode).toBe("cognition_missing_block_revision");
    let predicate: unknown = { kind: "generation_type", value: "normal" };
    for (let index = 0; index <= COGNITION_LIMITS_V1.maxPredicateDepth; index += 1) predicate = { kind: "not", child: predicate };
    const capped = validateCognitionIntegrity(snapshot({ cognition: { ...graph, policies: { workPolicy: [], workspaceUsage: [], completionCriteria: [], renderPolicy: [] }, templates: [{ id: "template-1", required: false, activation: predicate }] } }));
    expect(capped.repairCode).toBe("cognition_predicate_limit_exceeded");
  });

  test("scope ownership mismatch is retained but never ready", () => {
    const registry = new CognitionIntegrityRegistry();
    const scope = { userId: "user-1", presetId: "preset-1" } as const;
    const result = registry.register(scope, snapshot({ userId: "other-user" }));
    expect(result.agenticAllowed).toBe(false);
    expect(result.responseAvailable).toBe(true);
    expect(result.repairCode).toBe("cognition_foreign_authority_blocked");
    expect(registry.getSnapshot(scope).userId).toBe("other-user");
  });

  test("uses one deterministic primary reason without dropping secondary findings", () => {
    const result = validateCognitionIntegrity(snapshot({
      blockRefs: [{ blockId: "block-1", expectedRevision: 1, actualRevision: null }],
      repairRequired: true,
    }));
    expect(result.repairCode).toBe("cognition_repair_required");
    expect(result.issues.map((entry) => entry.code)).toEqual(["cognition_missing_block_revision", "cognition_repair_required"]);
  });

  test("normalizes imported cognition while preserving authored task data", () => {
    const authored = { agentsEnabled: true, templates: [{ id: "template-1", instruction: "retain this" }] };
    const normalized = normalizeImportedCognition(authored, { source: "foreign" });
    expect(normalized.data).toMatchObject({ templates: authored.templates, agentsEnabled: false, enabled: false, reviewRequired: true, authorityGranted: false });
    expect(normalized.agentsEnabled).toBe(false);
    expect(normalized.authorityGranted).toBe(false);
    expect(normalized.preserved).toBe(true);
    expect(normalized.data).not.toBe(authored);
    expect(authored.agentsEnabled).toBe(true);
    const legacy = normalizeLegacyCognition(authored);
    expect(legacy.source).toBe("legacy");
    expect(legacy.reviewRequired).toBe(true);
  });

  test("repair requires owner acknowledgement and exact cognition scope revision", () => {
    const registry = new CognitionIntegrityRegistry();
    const scope = { userId: "user-1", presetId: "preset-1" } as const;
    registry.register(scope, snapshot({ repairRequired: true }));
    const current = registry.readiness(scope);
    const repaired = registry.restore(scope, snapshot(), repairRequest({ expectedScopeRevision: current.scopeRevision, expectedCognitionRevision: current.cognitionRevision }));
    expect(repaired.authorized).toBe(true);
    expect(repaired.validation.agenticAllowed).toBe(true);
    expect(repaired.agenticActivationRequired).toBe(true);
    expect(registry.readiness(scope).agenticAllowed).toBe(true);
    expect(() => registry.restore(scope, snapshot(), repairRequest({ expectedScopeRevision: 1 }))).toThrowError(CognitionRepairError);
    expect(() => registry.restore(scope, snapshot(), repairRequest({ expectedScopeRevision: registry.readiness(scope).scopeRevision, authenticatedUserId: "other-user" }))).toThrowError(CognitionRepairError);
  });

  test("authorization and Loom block changes invalidate readiness without deleting authored state", () => {
    const registry = new CognitionIntegrityRegistry();
    const scope = { userId: "user-1", presetId: "preset-1" } as const;
    const authored = snapshot({ blockRefs: [{ blockId: "block-1", expectedRevision: 1, actualRevision: 1 }] });
    registry.register(scope, authored);
    registry.invalidateAuthorization(scope, "scope");
    expect(registry.readiness(scope)).toMatchObject({ agenticAllowed: false, responseAvailable: true, repairCode: "cognition_authorization_stale" });
    registry.invalidateBlockRevision(scope, "block-1");
    expect(registry.readiness(scope).repairCode).toBe("cognition_missing_block_revision");
    expect(registry.get(scope)?.preserved).toBe(true);
    expect(registry.getSnapshot(scope).blockRefs).toEqual(authored.blockRefs);
  });

  test("readiness encoding is canonical and cognition changes alter the digest", () => {
    const first = readiness({ reasons: ["z_reason", "cognition_invalid", "z_reason"] });
    const second = readiness({ reasons: ["cognition_invalid", "z_reason"] });
    expect(encodeAgenticReadinessVectorV1(first)).toBe(encodeAgenticReadinessVectorV1(second));
    expect(hashAgenticReadinessVectorV1(first)).toBe(hashAgenticReadinessVectorV1(second));
    expect(encodeAgenticReadinessVectorV1(first).indexOf('"schemaEpoch"')).toBeLessThan(encodeAgenticReadinessVectorV1(first).indexOf('"cognitionRevision"'));
    expect(hashAgenticReadinessVectorV1(first)).not.toBe(hashAgenticReadinessVectorV1({ ...first, cognitionRevision: 14 }));
  });

  test("cognition state cannot partially restore a ready vector", () => {
    const registry = new CognitionIntegrityRegistry();
    const scope = { userId: "user-1", presetId: "preset-1" } as const;
    registry.register(scope, snapshot({ repairRequired: true }));
    const next = applyCognitionReadinessV1(readiness(), registry.readiness(scope));
    expect(next.ready).toBe(false);
    expect(next.reasons).toContain("cognition_repair_required");
  });
});
