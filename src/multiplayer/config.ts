/**
 * Configuration for the host's link to a Lumiverse Multiplayer Identity Server.
 *
 * Self-hostable with a central default: a host opts into remote multiplayer by
 * setting MPIDENTITY_URL. Until then remote is OFF (fail-closed) and only the
 * Phase-1 local/LAN path is available. MPIDENTITY_ALLOW_PRIVATE permits a
 * loopback/LAN server URL (self-host / dev); by default private targets are
 * SSRF-blocked.
 */

// The officially-hosted attestation + relay server (cloud, nginx reverse proxy
// with TLS termination). Self-hosters override via MPIDENTITY_URL.
const DEFAULT_MPIDENTITY_URL = "https://mp-attest.lumiverse.chat";

export const mpidConfig = {
  /** The Identity Server base URL (no trailing slash). */
  get url(): string {
    return (process.env.MPIDENTITY_URL || DEFAULT_MPIDENTITY_URL).replace(/\/+$/, "");
  },
  /**
   * Remote multiplayer is available by default (a hosted central server exists
   * at DEFAULT_MPIDENTITY_URL). It is still OPT-IN per room — the host clicks
   * "Enable remote play" — this flag only means the feature is reachable. Opt
   * out entirely with MPIDENTITY_DISABLED=true or MPIDENTITY_URL="".
   */
  get enabled(): boolean {
    if (process.env.MPIDENTITY_DISABLED === "true") return false;
    return this.url.length > 0;
  },
  /** Allow a loopback/private Identity Server (self-host / dev). Off by default. */
  get allowPrivate(): boolean {
    return process.env.MPIDENTITY_ALLOW_PRIVATE === "true";
  },
  /** The relay WebSocket endpoint. */
  get relayWsUrl(): string {
    return this.url.replace(/^http/, "ws") + "/relay";
  },
};
