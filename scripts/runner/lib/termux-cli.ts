import { existsSync } from "fs";
import { join } from "path";

const TERMUX_PREFIX = "/data/data/com.termux/files/usr";

interface NpmCommandOptions {
  env?: Record<string, string | undefined>;
  which?: (name: string) => string | null | undefined;
  fileExists?: (path: string) => boolean;
}

/**
 * Termux can mis-handle bare `npm` argv under Bun.spawn and end up invoking
 * `node npm ...`, which makes Node resolve `npm` relative to cwd. Using the
 * absolute npm CLI path (or, failing that, the absolute npm shim path) keeps
 * the runner on the real system binary.
 */
export function npmCmd(args: string[], options: NpmCommandOptions = {}): string[] {
  const env = options.env ?? process.env;
  const isTermuxLike = env.LUMIVERSE_IS_TERMUX === "true" || env.LUMIVERSE_IS_PROOT === "true";
  if (!isTermuxLike) return ["npm", ...args];

  const which = options.which ?? ((name: string) => Bun.which(name));
  const fileExists = options.fileExists ?? existsSync;
  const prefix = env.PREFIX || TERMUX_PREFIX;

  const nodeBin = which("node") ?? (fileExists(join(prefix, "bin", "node")) ? join(prefix, "bin", "node") : null);
  const npmCli = join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  if (nodeBin && fileExists(npmCli)) {
    return [nodeBin, npmCli, ...args];
  }

  const npmBin = which("npm") ?? (fileExists(join(prefix, "bin", "npm")) ? join(prefix, "bin", "npm") : "npm");
  return [npmBin, ...args];
}
