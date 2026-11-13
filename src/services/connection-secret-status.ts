import type { PaginatedResult } from "../types/pagination";
import * as secretsSvc from "./secrets.service";

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
  if (!profile.has_api_key) return profile;
  const readable = !!(await secretsSvc.getSecretForStatus(userId, secretKey(profile.id)));
  return readable ? profile : { ...profile, has_api_key: false };
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
