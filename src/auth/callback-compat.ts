export const EXTERNAL_SSO_CALLBACK_PATH = "/api/auth/oauth2/callback";
export const BETTER_AUTH_SSO_CALLBACK_PATH = "/api/auth/callback";

export function getExternalSsoCallbackPath(providerId: string): string {
  return `${EXTERNAL_SSO_CALLBACK_PATH}/${providerId}`;
}

/**
 * Keep the callback URI registered with existing identity providers stable
 * while routing it to Better Auth 1.7's renamed callback endpoint.
 */
export function rewriteLegacySsoCallbackPath(pathname: string): string {
  const prefix = `${EXTERNAL_SSO_CALLBACK_PATH}/`;
  if (!pathname.startsWith(prefix)) return pathname;

  const providerId = pathname.slice(prefix.length);
  if (!providerId || providerId.includes("/")) return pathname;
  return `${BETTER_AUTH_SSO_CALLBACK_PATH}/${providerId}`;
}
