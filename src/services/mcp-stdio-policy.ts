/**
 * Stdio MCP servers spawn local child processes. Keep the supported command
 * surface narrow and block interpreter flags that execute inline code.
 */
const DEFAULT_STDIO_ALLOWED = [
  "node", "bun", "deno", "python", "python3",
  "npx", "uvx", "uv", "pipx", "pnpm", "yarn",
];

const STDIO_ALLOWED_COMMANDS = new Set(
  (process.env.MCP_STDIO_ALLOWED_COMMANDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(DEFAULT_STDIO_ALLOWED),
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
}
