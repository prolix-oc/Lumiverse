import { describe, expect, test } from "bun:test";

import {
  buildWorkspaceContextProjectionV1,
  serializeWorkspaceContextProjectionV1,
  utf8ByteLength,
  type WorkspaceContextEvidenceSourceV1,
  type WorkspaceContextProjectionInputV1,
} from "./workspace-context-projection.service";

function baseInput(overrides: Partial<WorkspaceContextProjectionInputV1> = {}): WorkspaceContextProjectionInputV1 {
  return {
    workspaceRevision: 7,
    objective: { id: "objective", text: "Keep the objective." },
    constraints: [{ id: "constraint", text: "Do not invent facts." }],
    ...overrides,
  };
}
function projection(input: WorkspaceContextProjectionInputV1, reservedBytes = 100_000) {
  return buildWorkspaceContextProjectionV1(input, { reservedBytes });
}

describe("buildWorkspaceContextProjectionV1", () => {
  test("fails closed when the mandatory tier exceeds its reserved budget", () => {
    expect(() => buildWorkspaceContextProjectionV1(
      baseInput({ objective: { id: "objective", text: "mandatory objective" } }),
      { reservedBytes: 1 },
    )).toThrowError(expect.objectContaining({ code: "workspace_context_limit_exceeded" }));
  });

  test("sorts IDs by UTF-8 bytes and optional records by fixed class/revision order", () => {
    const result = projection(baseInput({
      constraints: [
        { id: "é", text: "composed" },
        { id: "e\u0301", text: "decomposed" },
        { id: "😀", text: "emoji" },
      ],
      evidence: [
        { id: "artifact", class: "artifact", text: "artifact", sourceRevision: 4, digest: "artifact" },
        { id: "z", class: "finding", text: "z", sourceRevision: 2, digest: "z" },
        { id: "é", class: "finding", text: "composed", sourceRevision: 2, digest: "é-finding" },
        { id: "e\u0301", class: "finding", text: "decomposed", sourceRevision: 2, digest: "decomposed-finding" },
        { id: "submission", class: "accepted_submission", text: "submission", sourceRevision: 1, digest: "submission" },
        { id: "optional", class: "optional_task", text: "optional", sourceRevision: 9, digest: "optional" },
      ],
    }));
    expect(result.mandatory.map((record) => record.id)).toEqual(["objective", "e\u0301", "é", "😀"]);
    expect(result.optional.map((record) => record.kind)).toEqual([
      "accepted_submission", "finding", "finding", "finding", "optional_task", "artifact",
    ]);
    expect(result.optional.slice(1, 4).map((record) => record.id)).toEqual(["e\u0301", "z", "é"]);
  });

  test("collapses superseded task progress and duplicate evidence digests", () => {
    const result = projection(baseInput({
      requiredTasks: [{
        id: "task-1",
        state: "active",
        progress: [
          { state: "active", text: "old state", sourceRevision: 1, superseded: true },
          { state: "blocked", text: "current state", sourceRevision: 2 },
        ],
      }],
      evidence: [
        { id: "first", class: "finding", text: "same evidence", sourceRevision: 1, digest: "same" },
        { id: "duplicate", class: "finding", text: "same evidence", sourceRevision: 2, digest: "same" },
      ],
    }));
    expect(result.mandatory.find((record) => record.kind === "required_task")).toMatchObject({
      id: "task-1", taskState: "blocked", text: "current state", sourceRevision: 2,
    });
    expect(result.optional).toHaveLength(1);
    expect(result.optional[0]).toMatchObject({ id: "duplicate", sourceRevision: 2 });
  });

  test("cuts only complete records and reports the first omitted cursor", () => {
    const input = baseInput({ evidence: [
      { id: "included", class: "accepted_submission", text: "one", sourceRevision: 2, digest: "included" },
      { id: "omitted", class: "accepted_submission", text: "two", sourceRevision: 1, digest: "omitted" },
    ] });
    const mandatory = projection({ ...input, evidence: [] });
    const firstRecordBytes = utf8ByteLength('accepted_submission "included": "one"\n');
    const result = projection(input, mandatory.utf8Bytes + firstRecordBytes);
    expect(result.optional.map((record) => record.id)).toEqual(["included"]);
    expect(result.literal).toBe(`${mandatory.literal}accepted_submission "included": "one"\n`);
    expect(result.utf8Bytes).toBe(mandatory.utf8Bytes + firstRecordBytes);
    expect(result.literal).not.toContain("omitted");
    expect(result.omissions).toContainEqual({
      class: "accepted_submission", omittedCount: 1, firstOmittedCursor: "omitted",
    });
  });

  test("reports omission counts, cursors, and source revision for every class", () => {
    const input = baseInput({ workspaceRevision: 42, evidence: [
      { id: "s", class: "accepted_submission", text: "s", digest: "s" },
      { id: "f", class: "finding", text: "f", digest: "f" },
      { id: "t", class: "optional_task", text: "t", digest: "t" },
      { id: "a", class: "artifact", text: "a", digest: "a" },
    ] });
    const mandatory = projection({ ...input, evidence: [] });
    const result = projection(input, mandatory.utf8Bytes);
    expect(result.optional).toHaveLength(0);
    expect(result.sourceWorkspaceRevision).toBe(42);
    expect(result.omissions).toEqual([
      { class: "accepted_submission", omittedCount: 1, firstOmittedCursor: "s" },
      { class: "finding", omittedCount: 1, firstOmittedCursor: "f" },
      { class: "optional_task", omittedCount: 1, firstOmittedCursor: "t" },
      { class: "artifact", omittedCount: 1, firstOmittedCursor: "a" },
    ]);
  });

  test("produces deterministic bytes independent of source array order", () => {
    const input = baseInput({
      constraints: [{ id: "b", text: "B", sourceRevision: 2 }, { id: "a", text: "A", sourceRevision: 1 }],
      evidence: [
        { id: "f", class: "finding", text: "F", sourceRevision: 3, digest: "f" },
        { id: "s", class: "accepted_submission", text: "S", sourceRevision: 4, digest: "s" },
      ],
    });
    const reversed = { ...input, constraints: [...input.constraints!].reverse(), evidence: [...input.evidence!].reverse() };
    const first = projection(input);
    const second = projection(reversed);
    expect(second.literal).toBe(first.literal);
    expect(second.utf8Bytes).toBe(first.utf8Bytes);
    expect([...serializeWorkspaceContextProjectionV1(second)]).toEqual([...serializeWorkspaceContextProjectionV1(first)]);
  });

  test("canonicalizes shorthand constraints and mandatory revision ties", () => {
    const shorthand = baseInput({ constraints: ["first", "second"] });
    const shorthandReversed = { ...shorthand, constraints: [...shorthand.constraints!].reverse() };
    const first = projection(shorthand);
    const second = projection(shorthandReversed);
    expect(second.literal).toBe(first.literal);
    expect([...serializeWorkspaceContextProjectionV1(second)]).toEqual([
      ...serializeWorkspaceContextProjectionV1(first),
    ]);

    const tied = baseInput({
      acceptedDecisions: [
        { id: "same", text: "same", accepted: true, sourceRevision: 1 },
        { id: "same", text: "same", accepted: true, sourceRevision: 2 },
      ],
    });
    const tiedReversed = { ...tied, acceptedDecisions: [...tied.acceptedDecisions!].reverse() };
    expect(projection(tiedReversed).literal).toBe(projection(tied).literal);
  });

  test("filters accepted/unresolved mandatory records and excludes private fields/relevance", () => {
    const privateEvidence = {
      id: "public-finding", class: "finding" as const, text: "public evidence", digest: "public",
      relevance: 1, privateBody: "PRIVATE_BODY", reasoning: "PRIVATE_REASONING", toolArguments: "PRIVATE_ARGS",
    } as unknown as WorkspaceContextEvidenceSourceV1;
    const result = projection(baseInput({
      acceptedDecisions: [
        { id: "accepted", text: "keep", accepted: true },
        { id: "pending", text: "drop", accepted: false },
      ],
      unresolvedQuestions: [
        { id: "open", text: "keep", resolved: false },
        { id: "closed", text: "drop", resolved: true },
      ],
      evidence: [privateEvidence],
    }));
    const serialized = new TextDecoder().decode(serializeWorkspaceContextProjectionV1(result));
    expect(serialized).toContain("public evidence");
    expect(serialized).not.toContain("PRIVATE_BODY");
    expect(serialized).not.toContain("PRIVATE_REASONING");
    expect(serialized).not.toContain("PRIVATE_ARGS");
    expect(serialized).not.toContain("relevance");
    expect(result.mandatory.map((record) => record.id)).toEqual(["objective", "constraint", "accepted", "open"]);
  });
});
