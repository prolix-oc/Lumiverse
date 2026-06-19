export interface WeaverBuildTypeDef {
  id: string;
  enabled: boolean;
  order: number;
  hub?: boolean;
  door?: boolean;
  narration?: boolean;
  pairing?: boolean;
}

export const WEAVER_BUILD_TYPES: readonly WeaverBuildTypeDef[] = [
  { id: "character", enabled: true, order: 1, narration: true, pairing: true },
  { id: "world", enabled: true, order: 2, hub: true },
  { id: "import", enabled: true, order: 3, door: true },
];

export const DEFAULT_BUILD_TYPE = "character";

export function getBuildType(id: string): WeaverBuildTypeDef | undefined {
  return WEAVER_BUILD_TYPES.find((t) => t.id === id);
}

export function isEnabledBuildType(id: unknown): id is string {
  if (typeof id !== "string") return false;
  const def = getBuildType(id);
  return def?.enabled === true && !def.door;
}
