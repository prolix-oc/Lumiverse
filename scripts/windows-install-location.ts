import { win32 } from "node:path";

function normalizeWindowsPath(path: string): string {
  return win32.resolve(path).replace(/[\\/]+$/, "").toLocaleLowerCase("en-US");
}

/**
 * Returns true when an install root is System32 itself or one of its children.
 * Windows paths are case-insensitive, so this stays testable on every host by
 * using node:path's Windows implementation explicitly.
 */
export function isInsideWindowsSystem32(
  installRoot: string,
  windowsDirectory: string | undefined,
): boolean {
  if (!windowsDirectory || !win32.isAbsolute(installRoot) || !win32.isAbsolute(windowsDirectory)) {
    return false;
  }

  const normalizedRoot = normalizeWindowsPath(installRoot);
  const system32Root = normalizeWindowsPath(win32.join(windowsDirectory, "System32"));

  return normalizedRoot === system32Root || normalizedRoot.startsWith(`${system32Root}\\`);
}
