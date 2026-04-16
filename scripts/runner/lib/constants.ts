import { resolve, join } from "path";

export const PROJECT_ROOT = resolve(import.meta.dir, "../../..");
export const ENTRY = join(PROJECT_ROOT, "src/index.ts");
export const ENV_FILE = join(PROJECT_ROOT, ".env");

export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
export const AVAILABLE_BRANCHES = ["main", "staging"] as const;
export const STOP_FORCE_KILL_MS = 5000;
