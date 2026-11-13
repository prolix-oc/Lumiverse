import { env } from "../env";

export function isTermuxLikeEnvironment(): boolean {
  return Boolean(process.env.TERMUX_VERSION)
    || process.env.LUMIVERSE_IS_TERMUX === "true"
    || process.env.LUMIVERSE_IS_PROOT === "true"
    || process.env.PREFIX?.startsWith("/data/data/com.termux/") === true
    || process.env.HOME?.startsWith("/data/data/com.termux/files/home") === true
    || env.dataDir.startsWith("/data/data/com.termux/");
}
