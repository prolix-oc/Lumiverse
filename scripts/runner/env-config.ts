import { existsSync } from "fs";
import { ENV_FILE } from "./lib/constants.js";

export interface EnvConfig {
  port: number;
  trustAnyOrigin: boolean;
}

export function readEnvConfig(): EnvConfig {
  const config: EnvConfig = { port: 7860, trustAnyOrigin: false };
  if (!existsSync(ENV_FILE)) return config;

  const content = Bun.file(ENV_FILE).text();
  // text() is async but we need sync — use spawnSync to cat the file
  const result = Bun.spawnSync(["cat", ENV_FILE], { stdout: "pipe" });
  const text = result.stdout.toString();

  const portMatch = text.match(/^PORT=(\d+)/m);
  if (portMatch) config.port = parseInt(portMatch[1], 10);
  config.trustAnyOrigin = /^TRUST_ANY_ORIGIN=true$/m.test(text);

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
}
