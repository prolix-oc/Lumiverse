/**
 * Startup warmup for Illarin linked instances.
 *
 * Per installation: refresh credentials if stale, and push a declaration
 * update when the backend version differs from the one last accepted by
 * Illarin. Names and permissions cannot change through an update.
 */

import { join } from "path";
import * as svc from "../services/illarin-instance.service";
import type { IllarinInstance } from "../services/illarin-instance.service";
import { DEFAULT_APPLICATION_NAME, buildDeclaration, buildDeclarationUpdate } from "./declaration";
import { IllarinUnauthorizedError, updateInstanceDeclaration } from "./api";
import { getValidAccessToken, handleTerminalUnauthorized, refreshAccessToken } from "./tokens";
import type { IllarinScope } from "./types";

/** Backend version from package.json — the declaration-update trigger. */
export async function readBackendVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await Bun.file(join(import.meta.dir, "../../package.json")).text()) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function requestedScopes(instance: IllarinInstance): IllarinScope[] {
  const declared = instance.lastDeclaration?.permissions ?? instance.lastDeclaration?.scopes;
  if (Array.isArray(declared)) {
    return declared.flatMap((scope): IllarinScope[] => scope === "asset:receive" ? ["work:receive"] :
      scope === "work:receive" || scope === "library:sync" ? [scope] : []);
  }
  return instance.scopes as IllarinScope[];
}

async function warmOne(instance: IllarinInstance, currentVersion: string): Promise<void> {
  const accessToken = await getValidAccessToken(instance.userId);
  if (!accessToken) return; // Torn down during refresh; event already emitted.

  const declaration = buildDeclaration({
    applicationName: instance.applicationName || DEFAULT_APPLICATION_NAME,
    instanceName: instance.instanceName,
    applicationVersion: currentVersion,
    scopes: requestedScopes(instance),
    installsExtensions: svc.canInstallExtensions(instance.userId),
  });
  if (JSON.stringify(instance.lastDeclaration) === JSON.stringify(declaration)) return;
  const update = buildDeclarationUpdate(declaration);
  try {
    await updateInstanceDeclaration(instance.illarinUrl, accessToken, update);
  } catch (err) {
    if (!(err instanceof IllarinUnauthorizedError)) throw err;

    // An ordinary access-endpoint 401 gets exactly one serialized refresh and
    // one retry. A 401 from refresh is handled terminally inside tokens.ts.
    const refreshedToken = await refreshAccessToken(instance.userId);
    if (!refreshedToken) return;
    try {
      await updateInstanceDeclaration(instance.illarinUrl, refreshedToken, update);
    } catch (retryError) {
      if (!(retryError instanceof IllarinUnauthorizedError)) throw retryError;
      await handleTerminalUnauthorized(instance.userId, "unauthorized");
      return;
    }
  }
  svc.updateLastDeclaration(instance.userId, JSON.stringify(declaration));
}

/**
 * Warm every linked instance. Failures are per-installation: one broken
 * link never blocks the others. Called deferred at startup.
 */
export async function warmUpInstances(): Promise<void> {
  const instances = await svc.listIllarinInstances();
  if (instances.length === 0) return;

  const currentVersion = await readBackendVersion();
  for (const instance of instances) {
    try {
      await warmOne(instance, currentVersion);
    } catch (err) {
      if (err instanceof IllarinUnauthorizedError) {
        await handleTerminalUnauthorized(instance.userId, "unauthorized");
        continue;
      }
      // Transient (network, rate limit): retried on next startup or warmup.
      console.warn(
        `[Illarin] Declaration warmup skipped for "${instance.instanceName}":`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
