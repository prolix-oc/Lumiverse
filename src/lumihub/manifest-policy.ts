/**
 * LumiHub only needs the install state of assets it supplied. A user's local
 * and third-party entries stay inside Lumiverse and are never sent upstream.
 */
export type ManifestEntryType = "character" | "worldbook" | "preset";
export type ManifestSource = "local" | "chub" | "lumihub";

export interface ManifestEntry {
  slug: string;
  type: ManifestEntryType;
  name: string;
  creator: string;
  source: ManifestSource;
  /** Installed version label (presets), so the hub can flag outdated installs. */
  version?: string;
  installed_at: number;
}

export type LumiHubManifestEntry = Omit<ManifestEntry, "source"> & {
  source: "lumihub";
};

/** Select the only manifest records that may be sent to LumiHub. */
export function selectLumiHubManifestEntries(
  entries: readonly ManifestEntry[],
): LumiHubManifestEntry[] {
  return entries.filter((entry): entry is LumiHubManifestEntry => entry.source === "lumihub");
}
