import { createHash } from "node:crypto";

/** Keep provider aliases readable while preserving distinct qualified names. */
export function toProviderToolName(qualifiedName: string): string {
  let alias = qualifiedName.replace(/:/g, "__").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (!/^[a-zA-Z_]/.test(alias)) alias = `_${alias}`;
  if (alias === qualifiedName && alias.length <= 64) return alias;

  const hash = createHash("sha256").update(qualifiedName).digest("hex").slice(0, 12);
  return `${alias.slice(0, 51)}_${hash}`;
}
