// On Termux, the bare `bun` binary can't execute natively. start.sh detects
// the working invocation method and exports it via env vars so subprocess
// launches can mirror the same wrapping.
export function bunCmdForEnv(
  env: Record<string, string | undefined>,
  ...args: string[]
): string[] {
  const method = env.LUMIVERSE_BUN_METHOD;
  const bunPath = env.LUMIVERSE_BUN_PATH;

  if (!method || !bunPath) return ["bun", ...args];

  switch (method) {
    case "direct":
      return [bunPath, ...args];
    case "grun":
      return ["grun", bunPath, ...args];
    case "proot": {
      const prefix = env.PREFIX || "/data/data/com.termux/files/usr";
      return [
        "proot", "--link2symlink", "-0",
        `${prefix}/glibc/lib/ld-linux-aarch64.so.1`,
        "--library-path", `${prefix}/glibc/lib`,
        bunPath, ...args,
      ];
    }
    default:
      return [bunPath, ...args];
  }
}

export function bunCmd(...args: string[]): string[] {
  return bunCmdForEnv(process.env, ...args);
}
