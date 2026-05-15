import {
  assertValidSharedRpcEndpoint,
  normalizeOwnedSharedRpcEndpoint,
} from "./shared-rpc";

type SharedRpcRequestHandler = (
  requesterExtensionId: string,
  effectivePermissions: readonly string[]
) => Promise<unknown>;
type SharedRpcPermissionResolver = (extensionIdentifier: string) => readonly string[];

export type SharedRpcEndpointPolicy = {
  requires?: readonly string[];
};

type NormalizedSharedRpcEndpointPolicy = {
  requiredPermissions: readonly string[];
};

type SharedRpcEndpointRecord =
  | {
      mode: "sync";
      ownerExtensionId: string;
      endpoint: string;
      value: unknown;
      policy: NormalizedSharedRpcEndpointPolicy | null;
    }
  | {
      mode: "request";
      ownerExtensionId: string;
      endpoint: string;
      handler: SharedRpcRequestHandler;
      policy: NormalizedSharedRpcEndpointPolicy | null;
    };

const sharedRpcEndpoints = new Map<string, SharedRpcEndpointRecord>();
const sharedRpcByOwner = new Map<string, Set<string>>();

function trackOwnerEndpoint(ownerExtensionId: string, endpoint: string): void {
  let endpoints = sharedRpcByOwner.get(ownerExtensionId);
  if (!endpoints) {
    endpoints = new Set<string>();
    sharedRpcByOwner.set(ownerExtensionId, endpoints);
  }
  endpoints.add(endpoint);
}

function normalizeOwnedEndpoint(ownerExtensionId: string, endpoint: string): string {
  return normalizeOwnedSharedRpcEndpoint(ownerExtensionId, endpoint);
}

function normalizePolicy(policy?: SharedRpcEndpointPolicy): NormalizedSharedRpcEndpointPolicy | null {
  if (!policy || !Array.isArray(policy.requires)) return null;

  return {
    requiredPermissions: [...new Set(policy.requires.map((permission) => String(permission).trim()).filter(Boolean))].sort(),
  };
}

export function syncSharedRpcEndpoint(
  ownerExtensionId: string,
  endpoint: string,
  value: unknown,
  policy?: SharedRpcEndpointPolicy
): string {
  const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
  sharedRpcEndpoints.set(normalized, {
    mode: "sync",
    ownerExtensionId,
    endpoint: normalized,
    value,
    policy: normalizePolicy(policy),
  });
  trackOwnerEndpoint(ownerExtensionId, normalized);
  return normalized;
}

export function registerSharedRpcRequestEndpoint(
  ownerExtensionId: string,
  endpoint: string,
  handler: SharedRpcRequestHandler,
  policy?: SharedRpcEndpointPolicy
): string {
  const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
  sharedRpcEndpoints.set(normalized, {
    mode: "request",
    ownerExtensionId,
    endpoint: normalized,
    handler,
    policy: normalizePolicy(policy),
  });
  trackOwnerEndpoint(ownerExtensionId, normalized);
  return normalized;
}

export function unregisterSharedRpcEndpoint(ownerExtensionId: string, endpoint: string): void {
  const normalized = normalizeOwnedEndpoint(ownerExtensionId, endpoint);
  const existing = sharedRpcEndpoints.get(normalized);
  if (!existing || existing.ownerExtensionId !== ownerExtensionId) return;

  sharedRpcEndpoints.delete(normalized);

  const owned = sharedRpcByOwner.get(ownerExtensionId);
  if (!owned) return;
  owned.delete(normalized);
  if (owned.size === 0) {
    sharedRpcByOwner.delete(ownerExtensionId);
  }
}

export function unregisterSharedRpcEndpointsByOwner(ownerExtensionId: string): void {
  const owned = sharedRpcByOwner.get(ownerExtensionId);
  if (!owned) return;

  for (const endpoint of owned) {
    sharedRpcEndpoints.delete(endpoint);
  }

  sharedRpcByOwner.delete(ownerExtensionId);
}

export async function readSharedRpcEndpoint(
  endpoint: string,
  requesterExtensionId: string,
  getGrantedPermissions?: SharedRpcPermissionResolver
): Promise<unknown> {
  const normalized = assertValidSharedRpcEndpoint(endpoint);
  const record = sharedRpcEndpoints.get(normalized);

  if (!record) {
    throw new Error(`Shared RPC endpoint "${normalized}" is not registered`);
  }

  if (getGrantedPermissions) {
    assertRequesterCanReadEndpoint(
      normalized,
      requesterExtensionId,
      record.ownerExtensionId,
      record.policy,
      getGrantedPermissions,
    );
  }

  if (record.mode === "sync") {
    return record.value;
  }

  const effectivePermissions = getGrantedPermissions
    ? resolveEffectiveHandlerPermissions(
        requesterExtensionId,
        record.ownerExtensionId,
        record.policy,
        getGrantedPermissions,
      )
    : [];

  return await record.handler(requesterExtensionId, effectivePermissions);
}

function assertRequesterCanReadEndpoint(
  endpoint: string,
  requesterExtensionId: string,
  ownerExtensionId: string,
  policy: NormalizedSharedRpcEndpointPolicy | null,
  getGrantedPermissions: SharedRpcPermissionResolver
): void {
  const ownerPermissions = new Set(getGrantedPermissions(ownerExtensionId));
  const requiredPermissions = policy?.requiredPermissions ?? [...ownerPermissions].sort();
  if (requiredPermissions.length === 0) return;

  const requesterPermissions = new Set(getGrantedPermissions(requesterExtensionId));
  const missingFromRequester = requiredPermissions.filter((permission) => !requesterPermissions.has(permission));
  const missingFromOwner = policy
    ? requiredPermissions.filter((permission) => !ownerPermissions.has(permission))
    : [];
  if (missingFromRequester.length === 0 && missingFromOwner.length === 0) return;

  if (missingFromOwner.length > 0) {
    throw new Error(
      `Shared RPC endpoint "${endpoint}" requires owner "${ownerExtensionId}" permissions: ${missingFromOwner.join(", ")}`
    );
  }

  throw new Error(
    policy
      ? `Shared RPC endpoint "${endpoint}" requires requester "${requesterExtensionId}" permissions: ${missingFromRequester.join(", ")}`
      : `Shared RPC endpoint "${endpoint}" requires requester "${requesterExtensionId}" to inherit owner "${ownerExtensionId}" permissions: ${missingFromRequester.join(", ")}`
  );
}

function resolveEffectiveHandlerPermissions(
  requesterExtensionId: string,
  ownerExtensionId: string,
  policy: NormalizedSharedRpcEndpointPolicy | null,
  getGrantedPermissions: SharedRpcPermissionResolver
): readonly string[] {
  if (policy) return policy.requiredPermissions;

  const requesterPermissions = new Set(getGrantedPermissions(requesterExtensionId));
  return getGrantedPermissions(ownerExtensionId).filter((permission) => requesterPermissions.has(permission)).sort();
}

export function resetSharedRpcPoolForTests(): void {
  sharedRpcEndpoints.clear();
  sharedRpcByOwner.clear();
}
