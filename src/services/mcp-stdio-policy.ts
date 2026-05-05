/**
 * Stdio MCP servers spawn local child processes. Keep the supported command
 * surface narrow and block interpreter/package-runner argument injection.
 */
const DEFAULT_STDIO_ALLOWED = [
  "node", "bun", "deno", "python", "python3",
];

const PACKAGE_RUNNERS = new Set(["npx", "uvx", "uv", "pipx", "pnpm", "yarn"]);

const STDIO_ALLOWED_COMMANDS = new Set(
  (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(DEFAULT_STDIO_ALLOWED),
);

const STDIO_ALLOWED_PACKAGES = new Set(
  (process.env.MCP_STDIO_ALLOWED_PACKAGES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

function commandBasename(command: string): string {
  const lastSlash = Math.max(command.lastIndexOf("/"), command.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? command.slice(lastSlash + 1) : command;
  return base.toLowerCase().replace(/\.exe$/, "");
}

function assertStdioCommandAllowed(command: string): string {
  if (!command || typeof command !== "string") {
    throw new Error("MCP stdio command is required");
  }
  if (/[;&|`$<>\n\r]/.test(command)) {
    throw new Error("MCP stdio command contains disallowed characters");
  }

  const base = commandBasename(command);
  if (!STDIO_ALLOWED_COMMANDS.has(base)) {
    throw new Error(
      `MCP stdio command "${base}" is not in the allowlist. ` +
        `Set MCP_STDIO_ALLOWED_COMMANDS to extend it.`,
    );
  }
  return base;
}

function isInlineCodeArg(commandBase: string, arg: string): boolean {
  if (commandBase === "node" || commandBase === "bun") {
    return (
      arg === "-" ||
      arg === "-e" ||
      arg.startsWith("-e") ||
      arg === "--eval" ||
      arg.startsWith("--eval=") ||
      arg === "-p" ||
      arg.startsWith("-p") ||
      arg === "--print" ||
      arg.startsWith("--print=")
    );
  }

  if (commandBase === "python" || commandBase === "python3") {
    return arg === "-" || arg === "-c" || arg.startsWith("-c");
  }

  if (commandBase === "deno") {
    return arg === "eval";
  }

  return false;
}

function stripPackageVersion(spec: string): string {
  if (spec.startsWith("@")) {
    const versionSep = spec.indexOf("@", 1);
    return versionSep === -1 ? spec : spec.slice(0, versionSep);
  }
  const versionSep = spec.indexOf("@");
  return versionSep === -1 ? spec : spec.slice(0, versionSep);
}

function packageArgForRunner(commandBase: string, args: string[]): string | null {
  if (commandBase === "npx") {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === "-y" || arg === "--yes" || arg === "--no-install") continue;
      if (arg === "--") continue;
      if (arg === "--package" || arg === "-p" || arg.startsWith("--package=")) return null;
      if (arg.startsWith("-")) return null;
      return arg;
    }
  }

  if (commandBase === "uvx") {
    return args.find((arg) => !arg.startsWith("-")) ?? null;
  }

  if (commandBase === "uv") {
    if (args[0] !== "tool" || args[1] !== "run") return null;
    return args.slice(2).find((arg) => !arg.startsWith("-")) ?? null;
  }

  if (commandBase === "pipx") {
    if (args[0] !== "run") return null;
    return args.slice(1).find((arg) => !arg.startsWith("-")) ?? null;
  }

  if (commandBase === "pnpm" || commandBase === "yarn") {
    if (args[0] !== "dlx") return null;
    return args.slice(1).find((arg) => !arg.startsWith("-")) ?? null;
  }

  return null;
}

function assertPackageRunnerAllowed(commandBase: string, args: string[]): void {
  if (!PACKAGE_RUNNERS.has(commandBase)) return;
  if (STDIO_ALLOWED_PACKAGES.size === 0) {
    throw new Error(
      `MCP stdio package runner "${commandBase}" requires MCP_STDIO_ALLOWED_PACKAGES to allow specific packages`,
    );
  }

  const packageArg = packageArgForRunner(commandBase, args);
  if (!packageArg) {
    throw new Error(`MCP stdio package runner "${commandBase}" uses unsupported arguments`);
  }

  const packageName = stripPackageVersion(packageArg);
  if (!STDIO_ALLOWED_PACKAGES.has(packageName) && !STDIO_ALLOWED_PACKAGES.has(packageArg)) {
    throw new Error(`MCP stdio package "${packageName}" is not in MCP_STDIO_ALLOWED_PACKAGES`);
  }
}

export function assertStdioLaunchAllowed(command: string, args: unknown = []): asserts args is string[] {
  const commandBase = assertStdioCommandAllowed(command);
  if (!Array.isArray(args)) {
    throw new Error("MCP stdio args must be an array of strings");
  }
  if (args.length > 128) {
    throw new Error("MCP stdio args exceed the maximum count");
  }

  for (const arg of args) {
    if (typeof arg !== "string") {
      throw new Error("MCP stdio args must be an array of strings");
    }
    if (arg.length > 4096) {
      throw new Error("MCP stdio arg exceeds the maximum length");
    }
    if (/[\0\n\r]/.test(arg)) {
      throw new Error("MCP stdio arg contains disallowed characters");
    }
    if (isInlineCodeArg(commandBase, arg)) {
      throw new Error(`MCP stdio command "${commandBase}" cannot use inline-code argument "${arg}"`);
    }
  }

  assertPackageRunnerAllowed(commandBase, args);
}
