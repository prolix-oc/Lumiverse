import { existsSync, readFileSync } from "fs";
import { ENV_FILE } from "./lib/constants.js";

export interface EnvConfig {
  port: number;
  trustAnyOrigin: boolean;
  directTls: boolean;
  /** Null when direct TLS is enabled but its SAN hostname cannot be inferred. */
  browserUrl: string | null;
}

export function resolveServerBrowserUrl(
  port: number,
  directTls: boolean,
  authBaseUrl?: string,
): string | null {
  if (!directTls) return `http://localhost:${port}`;
  if (!authBaseUrl?.trim()) return null;
  try {
    const url = new URL(authBaseUrl.trim().replace(/^(?:"|')|(?:"|')$/g, ""));
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.pathname !== "/"
      || url.search
      || url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function readEnvConfig(): EnvConfig {
  const config: EnvConfig = {
    port: 7860,
    trustAnyOrigin: false,
    directTls: false,
    browserUrl: "http://localhost:7860",
  };
  const text = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf-8") : "";

  const portMatch = text.match(/^PORT=(\d+)/m);
  if (portMatch) config.port = parseInt(portMatch[1], 10);
  config.trustAnyOrigin = /^TRUST_ANY_ORIGIN=true$/m.test(text);
  config.directTls = Boolean(
    process.env.LUMIVERSE_TLS_CERT_FILE?.trim()
      || process.env.LUMIVERSE_TLS_CONFIG_FILE?.trim()
      || /^LUMIVERSE_TLS_(?:CERT|CONFIG)_FILE=\s*\S+/m.test(text),
  );
  const authBaseUrl = process.env.AUTH_BASE_URL
    || text.match(/^AUTH_BASE_URL=(.+)$/m)?.[1]?.trim();
  config.browserUrl = resolveServerBrowserUrl(config.port, config.directTls, authBaseUrl);

  return config;
}

export async function writeTrustAnyOrigin(enable: boolean): Promise<void> {
  if (!existsSync(ENV_FILE)) return;

  let content = await Bun.file(ENV_FILE).text();

  if (enable) {
    if (/^#?\s*TRUST_ANY_ORIGIN=/m.test(content)) {
      content = content.replace(
        /^#?\s*TRUST_ANY_ORIGIN=.*/m,
        "TRUST_ANY_ORIGIN=true"
      );
    } else {
      content =
        content.trimEnd() +
        "\n\n# Remote / mobile access (managed by runner)\nTRUST_ANY_ORIGIN=true\n";
    }
  } else {
    content = content.replace(
      /^TRUST_ANY_ORIGIN=true.*$/m,
      "# TRUST_ANY_ORIGIN=true"
    );
  }

  await Bun.write(ENV_FILE, content);

  // The runner is long-lived and passes its own process.env to the child
  // server on every restart. Bun's .env loader does NOT override an env
  // var that already exists, so if we only rewrite the file, the restarted
  // child inherits the runner's stale TRUST_ANY_ORIGIN and the toggle
  // appears to do nothing. Sync the runner's env to the new file state.
  if (enable) {
    process.env.TRUST_ANY_ORIGIN = "true";
  } else {
    delete process.env.TRUST_ANY_ORIGIN;
  }
}
