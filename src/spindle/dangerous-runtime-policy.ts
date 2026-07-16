/**
 * Canonical hard-block map for module specifiers that expose native host
 * capabilities. The scanner and cooperative runtime sandbox both consume
 * this table so their coverage cannot drift.
 */
export const BLOCKED_MODULE_SPECIFIER_LABELS = new Map<string, string>([
  ["fs", "filesystem module access"],
  ["fs/promises", "filesystem module access"],
  ["node:fs", "filesystem module access"],
  ["node:fs/promises", "filesystem module access"],
  ["child_process", "subprocess module access"],
  ["node:child_process", "subprocess module access"],
  ["net", "direct socket module access"],
  ["tls", "direct socket module access"],
  ["dgram", "direct socket module access"],
  ["http", "direct socket module access"],
  ["https", "direct socket module access"],
  ["node:net", "direct socket module access"],
  ["node:tls", "direct socket module access"],
  ["node:dgram", "direct socket module access"],
  ["node:http", "direct socket module access"],
  ["node:https", "direct socket module access"],
  ["dns", "direct socket module access"],
  ["dns/promises", "direct socket module access"],
  ["node:dns", "direct socket module access"],
  ["node:dns/promises", "direct socket module access"],
  ["http2", "direct socket module access"],
  ["node:http2", "direct socket module access"],
  ["inspector", "debugger module access"],
  ["node:inspector", "debugger module access"],
  ["inspector/promises", "debugger module access"],
  ["node:inspector/promises", "debugger module access"],
  ["worker_threads", "worker or cluster module access"],
  ["cluster", "worker or cluster module access"],
  ["node:worker_threads", "worker or cluster module access"],
  ["node:cluster", "worker or cluster module access"],
  ["module", "module loader access"],
  ["node:module", "module loader access"],
  ["vm", "module loader access"],
  ["node:vm", "module loader access"],
  ["process", "module loader access"],
  ["node:process", "module loader access"],
  ["bun", "module loader access"],
  ["bun:jsc", "module loading"],
  ["bun:ffi", "native FFI loader access"],
  ["node:ffi", "native FFI loader access"],
  ["bun:sqlite", "direct SQLite module access"],
  ["node:sqlite", "direct SQLite module access"],
  ["sqlite3", "direct SQLite module access"],
  ["better-sqlite3", "direct SQLite module access"],
]);

export const BLOCKED_BUN_API_LABELS = new Map<string, string>([
  ["$", "subprocess API usage"],
  ["env", "sensitive runtime API usage"],
  ["argv", "sensitive runtime API usage"],
  ["cwd", "sensitive runtime API usage"],
  ["main", "sensitive runtime API usage"],
  ["mmap", "direct filesystem API usage"],
  ["Glob", "direct filesystem API usage"],
  ["FileSystemRouter", "direct filesystem API usage"],
  ["build", "sensitive runtime API usage"],
  ["plugin", "sensitive runtime API usage"],
  ["resolve", "sensitive runtime API usage"],
  ["resolveSync", "sensitive runtime API usage"],
  ["which", "sensitive runtime API usage"],
  ["embeddedFiles", "sensitive runtime API usage"],
  ["FFI", "native FFI API usage"],
  ["unsafe", "native FFI API usage"],
  ["file", "dangerous Bun system API usage"],
  ["write", "dangerous Bun system API usage"],
  ["spawn", "dangerous Bun system API usage"],
  ["spawnSync", "dangerous Bun system API usage"],
  ["openInEditor", "sensitive runtime API usage"],
  ["serve", "direct network API usage"],
  ["connect", "direct network API usage"],
  ["listen", "direct network API usage"],
  ["udpSocket", "direct network API usage"],
  ["dns", "direct network API usage"],
  ["fetch", "direct network API usage"],
  ["sql", "direct network API usage"],
  ["SQL", "direct network API usage"],
  ["postgres", "direct network API usage"],
  ["redis", "direct network API usage"],
  ["RedisClient", "direct network API usage"],
  ["s3", "direct network API usage"],
  ["S3Client", "direct network API usage"],
  ["secrets", "sensitive runtime API usage"],
  ["stdin", "sensitive runtime API usage"],
  ["stdout", "sensitive runtime API usage"],
  ["stderr", "sensitive runtime API usage"],
  ["Terminal", "sensitive runtime API usage"],
  ["WebView", "sensitive runtime API usage"],
  ["cron", "sensitive runtime API usage"],
]);

export const BLOCKED_BUN_API_NAMES = [...BLOCKED_BUN_API_LABELS.keys()];

export const BLOCKED_GLOBAL_API_LABELS = new Map<string, string>([
  ["fetch", "direct network API usage"],
  ["WebSocket", "direct network API usage"],
  ["Worker", "worker runtime API usage"],
  ["BroadcastChannel", "worker runtime API usage"],
]);

export const BLOCKED_GLOBAL_API_NAMES = [...BLOCKED_GLOBAL_API_LABELS.keys()];

export const DANGEROUS_PROCESS_API_NAMES = [
  "env",
  "exit",
  "kill",
  "chdir",
  "dlopen",
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "mainModule",
  "abort",
] as const;

export const BLOCKED_PROCESS_API_NAMES = DANGEROUS_PROCESS_API_NAMES.filter(
  (name) => name !== "env",
);

export const SENSITIVE_ENV_PATTERNS = [
  /^LUMIVERSE_/i,
  /^AUTH_/i,
  /SECRET/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /ENCRYPTION_KEY/i,
  /API_KEY/i,
  /TOKEN/i,
  /CREDENTIAL/i,
  /SESSION/i,
  /JWT/i,
  /COOKIE/i,
  /BEARER/i,
  /(^|_)ACCESS_KEY(_|$)/i,
  /(?:DATABASE|POSTGRES(?:QL)?|MONGO(?:DB)?|REDIS)_URL/i,
  /^HOME$/i,
  /^USERPROFILE$/i,
  /^SSH_/i,
] as const;

export function isSensitiveEnvironmentKey(key: string): boolean {
  return SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key));
}

export function buildSafeEnvironment(
  rawEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (!isSensitiveEnvironmentKey(key) && typeof value === "string") {
      safe[key] = value;
    }
  }
  return safe;
}
