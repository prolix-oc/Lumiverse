import { join } from "path";

export const LUMIHUB_PROTOCOL_VERSION = 2;
export const PRESET_REGEX_VERSIONING_CAPABILITY = "preset_regex_versioning_v1";

export const LUMIHUB_CAPABILITIES = Object.freeze([
  "character_import",
  "chub_import",
  "worldbook_import",
  "theme_import",
  "preset_import",
  "manifest_sync",
  "stats_sync",
  PRESET_REGEX_VERSIONING_CAPABILITY,
]);

export interface LumiHubInstanceInfo {
  /** Original combined field retained so existing LumiHub servers keep working. */
  version: string;
  protocolVersion: number;
  backendVersion: string;
  frontendVersion: string;
  capabilities: readonly string[];
}

export function createLumiHubInstanceInfo(versions: {
  backendVersion: string;
  frontendVersion: string;
}): LumiHubInstanceInfo {
  return {
    version: versions.backendVersion,
    protocolVersion: LUMIHUB_PROTOCOL_VERSION,
    backendVersion: versions.backendVersion,
    frontendVersion: versions.frontendVersion,
    capabilities: LUMIHUB_CAPABILITIES,
  };
}

async function readPackageVersion(path: string): Promise<string> {
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : "unknown";
  } catch {
    return "unknown";
  }
}

let cachedInfo: Promise<LumiHubInstanceInfo> | null = null;

/** Report the two independently deployed app surfaces, not a hard-coded protocol version. */
export function getLumiHubInstanceInfo(): Promise<LumiHubInstanceInfo> {
  cachedInfo ??= Promise.all([
    readPackageVersion(join(import.meta.dir, "../../package.json")),
    readPackageVersion(join(import.meta.dir, "../../frontend/package.json")),
  ]).then(([backendVersion, frontendVersion]) => createLumiHubInstanceInfo({
    backendVersion,
    frontendVersion,
  }));
  return cachedInfo;
}
