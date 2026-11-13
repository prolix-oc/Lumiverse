import { appendFileSync, readFileSync } from "node:fs";
import { BridgeAPI, BUILDER_REPOSITORY, SOURCE_REPOSITORY } from "./private-linux-release";

interface Run {
  id: number; run_attempt: number; event: string; path: string; head_branch: string; head_sha: string;
  status: string; conclusion: string | null; display_title: string;
  repository: { full_name: string }; head_repository: { full_name: string };
}
const positive = (value: string) => /^[1-9]\d*$/.test(value);
export function validateNativeParent(run: Run, id: string, attempt: string, finished = false) {
  if (!positive(id) || !positive(attempt) || String(run.id) !== id || run.run_attempt !== Number(attempt)
    || run.event !== "workflow_dispatch" || !["main", "staging"].includes(run.head_branch)
    || run.path !== ".github/workflows/intel-lancedb.yml" || !/^[a-f0-9]{40}$/.test(run.head_sha)
    || run.repository.full_name !== SOURCE_REPOSITORY || run.head_repository.full_name !== SOURCE_REPOSITORY
    || (run.status === "completed" && run.conclusion !== "success") || (finished && run.status !== "completed")) {
    throw new Error("Untrusted Intel LanceDB source workflow");
  }
  return run.head_sha;
}
export function validateNativeBuilder(run: Run, id: string, attempt: string) {
  const match = /^Intel LanceDB ([1-9]\d*)\.([1-9]\d*)$/.exec(run.display_title);
  if (!positive(id) || !positive(attempt) || String(run.id) !== id || run.run_attempt !== Number(attempt)
    || run.event !== "workflow_dispatch" || run.head_branch !== "main" || run.path !== ".github/workflows/macos-lancedb.yml"
    || run.repository.full_name !== BUILDER_REPOSITORY || run.head_repository.full_name !== BUILDER_REPOSITORY || !match) {
    throw new Error("Untrusted Intel LanceDB builder workflow");
  }
  return { sourceRun: match[1]!, sourceAttempt: match[2]! };
}
function output(values: Record<string, string>) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}
async function main() {
  const mode = process.argv[2];
  const api = (repository: string) => new BridgeAPI(process.env.LINUX_RELEASE_BRIDGE_TOKEN!, repository);
  if (mode === "dispatch") {
    if (!["main", "staging"].includes(process.env.GITHUB_REF_NAME!)) throw new Error("Only trusted main or staging source may use the private runner");
    const run = process.env.GITHUB_RUN_ID!, attempt = process.env.GITHUB_RUN_ATTEMPT!, seed = process.env.NATIVE_SEED!;
    if (!positive(run) || !positive(attempt) || !["true", "false"].includes(seed)) throw new Error("Invalid native build request");
    await api(BUILDER_REPOSITORY).response("/actions/workflows/macos-lancedb.yml/dispatches", { ref: "main", inputs: { source_run: run, source_attempt: attempt, seed } });
  } else if (mode === "fetch") {
    const run = process.env.SOURCE_RUN_ID!, attempt = process.env.SOURCE_RUN_ATTEMPT!;
    if (!positive(run) || !positive(attempt)) throw new Error("Invalid native source run identity");
    const parent = await api(SOURCE_REPOSITORY).json<Run>(`/actions/runs/${run}`);
    output({ source: validateNativeParent(parent, run, attempt) });
  } else if (mode === "notify") {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
    const run = event.workflow_run as Run;
    validateNativeBuilder(run, String(run.id), String(run.run_attempt));
    await api(SOURCE_REPOSITORY).response("/actions/workflows/intel-lancedb-complete.yml/dispatches", {
      ref: "main", inputs: { builder_run: String(run.id), builder_attempt: String(run.run_attempt) },
    });
  } else if (mode === "resolve") {
    const id = process.env.BUILDER_RUN_ID!, attempt = process.env.BUILDER_RUN_ATTEMPT!;
    if (!positive(id) || !positive(attempt)) throw new Error("Invalid native builder run identity");
    const builder = await api(BUILDER_REPOSITORY).json<Run>(`/actions/runs/${id}`);
    const { sourceRun, sourceAttempt } = validateNativeBuilder(builder, id, attempt);
    if (builder.status !== "completed" || builder.conclusion !== "success") throw new Error("Private Intel LanceDB build did not succeed");
    const parent = await api(SOURCE_REPOSITORY).json<Run>(`/actions/runs/${sourceRun}`);
    const source = validateNativeParent(parent, sourceRun, sourceAttempt, true);
    output({ source, source_run: sourceRun, source_attempt: sourceAttempt, artifact: `intel-lancedb-${sourceRun}-${sourceAttempt}` });
  } else throw new Error("Use dispatch, fetch, notify or resolve");
}
if (import.meta.main) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
