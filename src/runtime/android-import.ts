export interface AndroidImportActivity {
  jobId: string;
  status: string;
  phase?: string;
  processed?: number;
  total?: number;
  bytesProcessed?: number;
  bytesTotal?: number;
}

/** Private Bun IPC to the APK supervisor. Never trust WebView messages for this. */
export function notifyAndroidImport(activity: AndroidImportActivity): void {
  const token = process.env.LUMIVERSE_BUNDLE_READY_TOKEN;
  if (!process.env.LUMIVERSE_ANDROID_HOST || !token || typeof process.send !== "function") return;
  try { process.send({ type: "android-import", token, activity }); } catch { /* supervisor is shutting down */ }
}

export function listenForAndroidImportCancellation(cancel: (jobId: string) => void): void {
  const token = process.env.LUMIVERSE_BUNDLE_READY_TOKEN;
  if (!process.env.LUMIVERSE_ANDROID_HOST || !token || typeof process.send !== "function") return;
  process.on("message", (message: unknown) => {
    const command = message as { type?: string; token?: string; jobId?: string } | null;
    if (command?.type === "android-import-cancel" && command.token === token &&
      typeof command.jobId === "string" && /^[\w-]{1,128}$/.test(command.jobId)) cancel(command.jobId);
  });
}
