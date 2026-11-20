import { expect, test } from "bun:test";
import { BUILDER_REPOSITORY, SOURCE_REPOSITORY } from "./private-linux-release";
import { validateNativeBuilder, validateNativeParent } from "./intel-lancedb-bridge";

const parent = { id: 123, run_attempt: 2, event: "workflow_dispatch", path: ".github/workflows/intel-lancedb.yml",
  head_branch: "staging", head_sha: "a".repeat(40), status: "completed", conclusion: "success", display_title: "Intel LanceDB Native Dependency",
  repository: { full_name: SOURCE_REPOSITORY }, head_repository: { full_name: SOURCE_REPOSITORY } };
const builder = { ...parent, id: 456, path: ".github/workflows/macos-lancedb.yml", head_branch: "main",
  display_title: "Intel LanceDB 123.2", repository: { full_name: BUILDER_REPOSITORY }, head_repository: { full_name: BUILDER_REPOSITORY } };

test("native requests bind a trusted dispatch and exact source run attempt", () => {
  expect(validateNativeParent(parent, "123", "2", true)).toBe(parent.head_sha);
  for (const changed of [{ head_branch: "feature" }, { event: "pull_request" }, { path: ".github/workflows/other.yml" },
    { run_attempt: 1 }, { head_sha: "bad" }, { conclusion: "failure" }, { head_repository: { full_name: "attacker/repo" } }]) {
    expect(() => validateNativeParent({ ...parent, ...changed }, "123", "2")).toThrow();
  }
  expect(() => validateNativeParent({ ...parent, status: "in_progress", conclusion: null }, "123", "2", true)).toThrow();
});
test("native handoffs bind a private main-branch workflow run and its parent", () => {
  expect(validateNativeBuilder(builder, "456", "2")).toEqual({ sourceRun: "123", sourceAttempt: "2" });
  for (const changed of [{ display_title: "Intel LanceDB 123.0" }, { event: "push" }, { head_branch: "staging" },
    { path: ".github/workflows/other.yml" }, { run_attempt: 3 }, { repository: { full_name: "attacker/repo" } }]) {
    expect(() => validateNativeBuilder({ ...builder, ...changed }, "456", "2")).toThrow();
  }
});
