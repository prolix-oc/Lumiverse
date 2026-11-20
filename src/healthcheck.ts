import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const port = Bun.env.PORT || "7860";
const directTls = Boolean(
  Bun.env.LUMIVERSE_TLS_CERT_FILE?.trim()
    || Bun.env.LUMIVERSE_TLS_CONFIG_FILE?.trim(),
);

function firstConfiguredServerName(): string | undefined {
  const configuredPath = Bun.env.LUMIVERSE_TLS_CONFIG_FILE?.trim();
  if (!configuredPath) return undefined;
  try {
    const path = isAbsolute(configuredPath) ? configuredPath : resolve(configuredPath);
    const manifest = JSON.parse(readFileSync(path, "utf8")) as {
      certificates?: Array<{ serverNames?: unknown }>;
    };
    const names = manifest.certificates?.[0]?.serverNames;
    if (!Array.isArray(names)) return undefined;
    return names.find((name): name is string => typeof name === "string" && name.length > 0);
  } catch {
    // The main process reports the actionable manifest error. A failed health
    // check is sufficient here while Docker waits for it to recover.
    return undefined;
  }
}

try {
  const url = `${directTls ? "https" : "http"}://127.0.0.1:${port}/`;
  const serverName = firstConfiguredServerName();
  const response = await fetch(url, directTls
    ? {
        tls: {
          rejectUnauthorized: false,
          ...(serverName ? { serverName } : {}),
        },
      }
    : undefined);
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
