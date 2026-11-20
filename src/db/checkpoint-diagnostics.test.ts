import { expect, test } from "bun:test";
import { formatCheckpointDiagnostics } from "./checkpoint-diagnostics";

test("checkpoint diagnostics expose partial progress even when PASSIVE reports busy=0", () => {
  expect(formatCheckpointDiagnostics({ busy: 0, log: 900, checkpointed: 100 }))
    .toBe(" mode=PASSIVE busy=0 walPages=900 checkpointedPages=100 remainingPages=800");
  expect(formatCheckpointDiagnostics({ busy: 0, log: 900, checkpointed: 900 })).toContain("remainingPages=0");
  expect(formatCheckpointDiagnostics({ busy: 1, log: 900, checkpointed: 100 })).toContain("busy=1");
});

test("checkpoint diagnostics distinguish unavailable counts from a clean WAL", () => {
  expect(formatCheckpointDiagnostics({ busy: 0, log: -1, checkpointed: -1 })).toContain("remainingPages=unknown");
  for (const result of [undefined, null, 1, {}, { busy: "0", log: 10, checkpointed: 10 }]) {
    expect(formatCheckpointDiagnostics(result)).toBe("");
  }
});
