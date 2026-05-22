import { validateIdentifier } from "lumiverse-spindle-types";

const CHANNEL_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

function splitEndpoint(endpoint: string): string[] {
  return endpoint.split(".").filter(Boolean);
}

export function isValidSharedRpcEndpoint(endpoint: string): boolean {
  const trimmed = String(endpoint || "").trim();
  if (!trimmed) return false;

  const parts = splitEndpoint(trimmed);
  if (parts.length < 2) return false;
  if (!validateIdentifier(parts[0]!)) return false;

  return parts.slice(1).every((part) => CHANNEL_SEGMENT_PATTERN.test(part));
}

export function assertValidSharedRpcEndpoint(endpoint: string): string {
  const trimmed = String(endpoint || "").trim();
  if (!isValidSharedRpcEndpoint(trimmed)) {
    throw new Error(
      `Invalid shared RPC endpoint "${trimmed}". Expected "<extension_id>.<channel>" using lowercase letters, numbers, "_", and "-".`
    );
  }
  return trimmed;
}

export function normalizeOwnedSharedRpcEndpoint(extensionIdentifier: string, endpoint: string): string {
  const owner = String(extensionIdentifier || "").trim();
  if (!validateIdentifier(owner)) {
    throw new Error(`Invalid shared RPC owner identifier "${owner}"`);
  }

  const trimmed = String(endpoint || "").trim();
  if (!trimmed) {
    throw new Error("Shared RPC endpoint cannot be empty");
  }

  if (trimmed.startsWith(`${owner}.`) && isValidSharedRpcEndpoint(trimmed)) {
    return trimmed;
  }

  return assertValidSharedRpcEndpoint(`${owner}.${trimmed}`);
}
