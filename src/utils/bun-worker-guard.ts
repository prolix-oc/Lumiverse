const WINDOWS_BUN_WORKER_OVERRIDE = "LUMIVERSE_FORCE_BUN_WORKERS";

const warnedContexts = new Set<string>();

export function shouldUseBunWorkers(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (platform !== "win32") return true;
  return env[WINDOWS_BUN_WORKER_OVERRIDE] === "1";
}

export function warnBunWorkerFallback(context: string): void {
  if (shouldUseBunWorkers() || warnedContexts.has(context)) return;
  warnedContexts.add(context);
  console.warn(
    `[bun] ${context} is using a Windows fallback instead of Bun workers to avoid known Bun worker crashes. Set ${WINDOWS_BUN_WORKER_OVERRIDE}=1 to re-enable Bun workers.`,
  );
}
