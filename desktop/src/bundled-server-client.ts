import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RunnerClient, type FullStatus } from "./runner-client";

/** Uses the native owner of the bundled executable in place of a checkout. */
export class BundledServerClient extends RunnerClient {
  override async init(): Promise<void> {
    await listen<FullStatus>("bundled-server-status", ({ payload }) => this.onState?.(payload.state));
    await listen<boolean>("bundled-server-exit", ({ payload }) => this.onExit?.(payload ? 0 : 1));
  }
  override alive(): Promise<boolean> { return invoke("bundled_server_alive"); }
  override spawn(): Promise<void> { return invoke("bundled_server_start"); }
  override kill(): Promise<void> { return invoke("bundled_server_stop"); }
  override shutdown(): Promise<void> { return invoke("bundled_server_stop"); }
  override fullStatus(): Promise<FullStatus> { return invoke("bundled_server_status"); }
  override async request<T>(type: string): Promise<T> {
    switch (type) {
      case "full-status": return this.fullStatus() as Promise<T>;
      case "start-server": await this.spawn(); return undefined as T;
      case "stop-server": await this.shutdown(); return undefined as T;
      default: throw new Error("Update this bundled server by installing a new desktop build.");
    }
  }
}
