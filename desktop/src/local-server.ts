import { BundledServerClient } from "./bundled-server-client";
import { RunnerClient, type FullStatus } from "./runner-client";

export type LocalServerSource = "bundled" | "checkout";

/** Existing users keep their checkout unless they explicitly chose the built-in server. */
export function resolveLocalServerSource(saved: unknown, repoDir: unknown, bundledAvailable: boolean): LocalServerSource {
  if (saved === "checkout" || !bundledAvailable) return "checkout";
  if (saved === "bundled") return "bundled";
  return typeof repoDir === "string" && repoDir.trim() ? "checkout" : "bundled";
}

/** Both local implementations share tray controls; changing source first stops the old owner. */
export class LocalServerClient extends RunnerClient {
  source: LocalServerSource = "checkout";
  constructor(private readonly clients: Record<LocalServerSource, RunnerClient> = {
    checkout: new RunnerClient(), bundled: new BundledServerClient(),
  }) { super(); }

  private get active(): RunnerClient { return this.clients[this.source]; }

  override async init(source: LocalServerSource = "checkout"): Promise<void> {
    this.source = source;
    for (const client of Object.values(this.clients)) {
      client.onState = (state) => { if (client === this.active) this.onState?.(state); };
      client.onProgress = (operation, message) => { if (client === this.active) this.onProgress?.(operation, message); };
      client.onExit = (code) => { if (client === this.active) this.onExit?.(code); };
      await client.init();
    }
  }

  async select(source: LocalServerSource, checkoutChanged = false): Promise<void> {
    if (source === this.source && !checkoutChanged) return;
    await this.active.shutdown();
    this.source = source;
  }

  override alive(): Promise<boolean> { return this.active.alive(); }
  override spawn(repoDir: string, bunPath: string): Promise<void> { return this.active.spawn(repoDir, bunPath); }
  override kill(): Promise<void> { return this.active.kill(); }
  override shutdown(timeoutMs?: number): Promise<void> { return this.active.shutdown(timeoutMs); }
  override fullStatus(): Promise<FullStatus> { return this.active.fullStatus(); }
  override request<T>(type: string, payload?: unknown, timeoutMs?: number): Promise<T> {
    return this.active.request<T>(type, payload, timeoutMs);
  }
}
