/** Only tracked Illarin installs participate in its library mirror. */
export function getIllarinPresetWorkId(metadata: Record<string, unknown> | undefined): string | null {
  if (metadata?._lumiverse_install_source !== "illarin") return null;
  const id = metadata._lumiverse_illarin_asset_id ?? metadata._lumiverse_lumihub_id;
  return typeof id === "string" && id.trim() ? id : null;
}

export function getIllarinPresetVersionNumber(metadata: Record<string, unknown>): number | undefined {
  const value = metadata._lumiverse_illarin_version_number;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
