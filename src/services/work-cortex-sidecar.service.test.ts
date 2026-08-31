import { describe, expect, test } from "bun:test";
import type { AgentInspectionCorrelationV1 } from "../types/agent-run-projection";
import {
  admitCortexSidecar,
  createCortexAuthorizedSnapshot,
  CortexSidecarError,
  type AdmitCortexSidecarInputV1,
  type CortexAuthorizedSnapshotInputV1,
  type CortexAuthorizedSnapshotV1,
} from "./work-cortex-sidecar.service";

const CORRELATION: AgentInspectionCorrelationV1 = {
  turnSessionId: "turn-1",
  runId: "run-1",
  attemptId: "attempt-1",
  chatId: "chat-1",
  generationId: "generation-1",
  messageId: "message-1",
  swipeId: 0,
  actorId: null,
  recipientId: null,
  phase: "WORK",
  taskId: null,
  toolId: null,
  parentId: null,
  hostCorrelationId: "host-1",
  hostSequence: 1,
};

function makeSnapshot(
  value: unknown = { memories: [{ id: "memory-1", text: "pinned" }] },
  overrides: Partial<CortexAuthorizedSnapshotInputV1> = {},
): CortexAuthorizedSnapshotV1 {
  return createCortexAuthorizedSnapshot({
    ownerId: "owner-1",
    attemptId: "attempt-1",
    chatId: "chat-1",
    targetMessageId: "message-1",
    targetSwipeId: 0,
    checkpoint: "WORK",
    snapshotId: "cortex-snapshot-1",
    revision: "revision-1",
    value,
    ...overrides,
  });
}

function admit(
  snapshot: CortexAuthorizedSnapshotV1,
  overrides: Partial<AdmitCortexSidecarInputV1> = {},
) {
  return admitCortexSidecar({
    ownerId: "owner-1",
    attemptId: "attempt-1",
    scope: snapshot.scope,
    snapshot,
    checkpoint: "WORK",
    revision: snapshot.revision,
    required: false,
    requestId: "cortex-request-1",
    correlation: CORRELATION,
    ...overrides,
  });
}

describe("WORK Cortex sidecar admission", () => {
  test("pins a bounded immutable snapshot and exposes no authority-bearing capability", async () => {
    const source = { memories: [{ id: "memory-1", text: "pinned" }] };
    const snapshot = makeSnapshot(source);

    source.memories[0]!.text = "mutated after admission";
    expect(snapshot.value).toEqual({ memories: [{ id: "memory-1", text: "pinned" }] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.value as object)).toBe(true);
    expect(Object.keys(snapshot)).not.toEqual(expect.arrayContaining([
      "write",
      "publish",
      "complete",
      "delegate",
      "tools",
    ]));

    let readerArguments: unknown[] | undefined;
    const result = await admit(snapshot, {
      read: (value, signal) => {
        readerArguments = [value, signal];
        expect(Object.isFrozen(value as object)).toBe(true);
        return { memories: [{ id: "memory-1", text: "read-only result" }] };
      },
    }).read();

    expect(readerArguments).toHaveLength(2);
    expect(result.kind).toBe("accepted");
    if (result.kind === "accepted") {
      expect(result.value).toEqual({ memories: [{ id: "memory-1", text: "read-only result" }] });
      expect(result.receipt).toMatchObject({
        checkpoint: "WORK",
        state: "accepted",
        required: false,
        canonical: false,
        resultCount: 1,
      });
      expect(result.receipt.resultDigest).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test("admits exactly WORK and rejects render or commit checkpoints", () => {
    expect(() => makeSnapshot(true, { checkpoint: "RENDER" as never })).toThrow(
      "Cortex snapshot checkpoint must be WORK",
    );
    const snapshot = makeSnapshot();
    expect(() => admit(snapshot, { checkpoint: "PREPARE_COMMIT" as never })).toThrow(
      "Cortex sidecar checkpoint must be WORK",
    );
  });

  test("rejects an owner, scope, or revision mismatch instead of widening the snapshot", () => {
    const snapshot = makeSnapshot();
    expect(() => admit(snapshot, { ownerId: "other-owner" })).toThrow("owner/attempt mismatch");
    expect(() => admit(snapshot, { scope: { ...snapshot.scope, chatId: "other-chat" } })).toThrow("scope mismatch");
    expect(() => admit(snapshot, { revision: "revision-2" })).toThrow("revision mismatch");

    return expect(admit(snapshot).read({ revision: "revision-2" })).resolves.toMatchObject({
      kind: "omission",
      omission: { reason: "stale", required: false },
      receipt: { state: "omitted", canonical: false },
    });
  });

  test("turns optional stale, unavailable, and failed reads into visible omissions", async () => {
    const stale = await admit(makeSnapshot(true, { availability: "stale" })).read();
    expect(stale).toMatchObject({
      kind: "omission",
      omission: { reason: "stale", required: false },
      receipt: { state: "omitted", reason: "stale_input", resultDigest: null, resultCount: 0 },
    });

    const unavailable = await admit(makeSnapshot(true, { availability: "unavailable" })).read();
    expect(unavailable).toMatchObject({
      kind: "omission",
      omission: { reason: "unavailable", required: false },
      receipt: { state: "omitted", reason: "unavailable", canonical: false },
    });

    const failed = await admit(makeSnapshot(), {
      read: () => {
        throw new Error("provider failed");
      },
    }).read();
    expect(failed).toMatchObject({
      kind: "omission",
      omission: { reason: "failed", required: false },
      receipt: { state: "omitted", reason: "needs_attention" },
    });
  });

  test("required failures are typed terminal errors, not optional omissions", async () => {
    const required = admit(makeSnapshot(true, { availability: "unavailable" }), { required: true });
    try {
      await required.read();
      throw new Error("expected required Cortex read to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CortexSidecarError);
      expect(error).toMatchObject({
        name: "CortexSidecarError",
        code: "unavailable",
        omission: { reason: "unavailable", required: true },
        receipt: { state: "failed", required: true, canonical: false },
      });
    }
  });

  test("cascades cancellation into a cancelled receipt for both requiredness modes", async () => {
    const optionalController = new AbortController();
    optionalController.abort("parent cancelled");
    const optional = await admit(makeSnapshot(), { signal: optionalController.signal }).read();
    expect(optional).toMatchObject({
      kind: "omission",
      omission: { reason: "cancelled", required: false },
      receipt: { state: "cancelled", canonical: false },
    });

    const requiredController = new AbortController();
    requiredController.abort("parent cancelled");
    try {
      await admit(makeSnapshot(), { required: true, signal: requiredController.signal }).read();
      throw new Error("expected required Cortex cancellation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CortexSidecarError);
      expect(error).toMatchObject({
        code: "cancelled",
        omission: { reason: "cancelled", required: true },
        receipt: { state: "cancelled", required: true },
      });
    }
  });
});
