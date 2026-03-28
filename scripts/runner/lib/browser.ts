import { terminalEnv } from "./terminal.js";

/**
 * Open a URL in the default browser (cross-platform).
 *
 * Windows: `start` is a cmd.exe built-in, not a standalone executable,
 * so it must be invoked via `cmd /c start`. The empty "" is the window
 * title argument — without it, cmd treats a quoted URL as the title.
 *
 * Termux: `xdg-open` doesn't exist; use `termux-open-url` (Termux:API)
 * or `am start` (Android activity manager) as fallback.
 */
export function openBrowser(url: string): void {
  const opts = { stdout: "ignore" as const, stderr: "ignore" as const };

  if (process.platform === "darwin") {
    Bun.spawn(["open", url], opts);
  } else if (process.platform === "win32") {
    Bun.spawn(["cmd", "/c", "start", "", url], opts);
  } else if (terminalEnv.isTermux) {
    // termux-open-url requires the Termux:API add-on; fall back to am start
    try {
      Bun.spawn(["termux-open-url", url], opts);
    } catch {
      Bun.spawn(["am", "start", "-a", "android.intent.action.VIEW", "-d", url], opts);
    }
  } else {
    Bun.spawn(["xdg-open", url], opts);
  }
}
