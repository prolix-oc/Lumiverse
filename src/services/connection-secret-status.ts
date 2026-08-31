import type { PaginatedResult } from "../types/pagination";
import * as secretsSvc from "./secrets.service";
import { sanitizeConnectionMetadata } from "./connection-authority";
interface ApiKeyProfile {
  id: string;
  has_api_key: boolean;
}

type ReconciledApiKeyProfile<T extends ApiKeyProfile> = Omit<T, "has_api_key"> & {
  has_api_key: boolean;
};

/**
 * Reconcile a persisted `has_api_key` flag with the encrypted row's actual
 * readability before returning a profile to a settings UI.
 */
export async function withReadableApiKeyStatus<T extends ApiKeyProfile>(
  userId: string,
  profile: T,
  secretKey: (id: string) => string,
): Promise<ReconciledApiKeyProfile<T>> {
  const publicProfile = "metadata" in profile && profile.metadata && typeof profile.metadata === "object"
    ? { ...profile, metadata: sanitizeConnectionMetadata(profile.metadata as Record<string, unknown>) } as T
    : profile;
  if (!publicProfile.has_api_key) return publicProfile;
  const readable = !!(await secretsSvc.getSecretForStatus(userId, secretKey(publicProfile.id)));
  return readable ? publicProfile : { ...publicProfile, has_api_key: false };
}

export async function withReadableApiKeyStatuses<T extends ApiKeyProfile>(
  userId: string,
  result: PaginatedResult<T>,
  secretKey: (id: string) => string,
): Promise<PaginatedResult<ReconciledApiKeyProfile<T>>> {
  return {
    ...result,
    data: await Promise.all(result.data.map((profile) => withReadableApiKeyStatus(userId, profile, secretKey))),
  };
}
