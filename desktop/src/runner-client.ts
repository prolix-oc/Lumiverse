/**
 * Client for the headless Lumiverse runner (scripts/runner.ts --headless).
 *
 * The Rust process host (src-tauri/src/runner.rs) owns the child process
 * and relays its protocol frames as `runner-frame` events; commands go
 * back through the `runner_send` invoke. This class adds request/response
 * correlation on top, using the same {type, id, payload} message shapes
 * as the upstream Operator panel IPC.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type ServerState = "starting" | "running" | "stopping" | "stopped" | "crashed";

export interface FullStatus {
  state: ServerState;
  pid: number | null;
  startedAt: number | null;
  port: number;
  branch: string;
  version: string;
  updateAvailable: boolean;
  commitsBehind: number;
  latestUpdateMessage: string;
}

export interface UpdateState {
  available: boolean;
  commitsBehind: number;
  latestMessage: string;
}

export interface DesktopShellState {
  stale: boolean;
  builtSha: string | null;
  requiredSha: string | null;
}

interface ResponsePayload {
  success: boolean;
  data?: unknown;
  error?: string;
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class RunnerClient {
  private pending = new Map<string, Pending>();
  private exitWaiters = new Set<() => void>();
  private seq = 0;

  /** Server state pushed by the runner ({type:"state"} frames). */
  onState: ((state: ServerState) => void) | null = null;
  /** Progress events from long operations (updates, rebuilds). */
  onProgress: ((operation: string, message: string) => void) | null = null;
  /** The runner process ended. */
  onExit: ((code: number | null) => void) | null = null;

  async init(): Promise<void> {
    await listen<string>("runner-frame", (event) => this.handleFrame(event.payload));
    await listen<number | null>("runner-exit", (event) => {
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Runner exited"));
      }
      this.pending.clear();
      for (const waiter of this.exitWaiters) waiter();
      this.exitWaiters.clear();
      this.onExit?.(event.payload);
    });
  }

  alive(): Promise<boolean> {
    return invoke<boolean>("runner_alive");
  }

  /** Spawn the runner if it isn't already running. */
  async spawn(repoDir: string, bunPath: string): Promise<void> {
    await invoke("runner_start", { repoDir, bunPath });
  }

  /** Force-kill the runner process (last resort). */
  async kill(): Promise<void> {
    await invoke("runner_kill");
  }

  /**
   * Stop the runner and server, allowing a bounded graceful shutdown before
   * forcing the process tree to exit. The deadline includes the alive probe
   * and stdin write, and completion depends on process exit, not its quit ack.
   */
  async shutdown(timeoutMs = 15_000): Promise<void> {
    let finished = false;
    let didExit = false;
    let onExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      onExit = () => {
        didExit = true;
        resolve();
      };
      this.exitWaiters.add(onExit);
    });
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for runner exit")), timeoutMs);
    });

    const graceful = async () => {
      const alive = await this.alive();
      // A late alive response must not send quit to a replacement runner after
      // this shutdown has already timed out or observed the old runner exit.
      if (!alive || finished || didExit) return;
      const line = JSON.stringify({ type: "quit", id: `tray-${++this.seq}` });
      await Promise.race([invoke("runner_send", { line }), exited]);
      await exited;
    };

    try {
      await Promise.race([graceful(), exited, deadline]);
    } catch {
      finished = true;
      await this.kill();
    } finally {
      finished = true;
      clearTimeout(timer!);
      this.exitWaiters.delete(onExit);
    }
  }

  /**
   * Send a protocol command and await its response frame. Long operations
   * ack early and then stream progress via onProgress.
   */
  async request<T>(type: string, payload?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const id = `tray-${++this.seq}`;
    const message = JSON.stringify({ type, id, payload });

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request '${type}' timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      invoke("runner_send", { line: message }).catch((err) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  fullStatus(): Promise<FullStatus> {
    return this.request<FullStatus>("full-status");
  }

  private handleFrame(json: string): void {
    let frame: { type?: string; id?: string; payload?: unknown };
    try {
      frame = JSON.parse(json);
    } catch {
      return;
    }
    if (!frame.type) return;

    if (frame.type === "state") {
      const state = (frame.payload as { state?: ServerState })?.state;
      if (state) this.onState?.(state);
      return;
    }

    if (frame.type === "progress") {
      const payload = frame.payload as { operation?: string; message?: string };
      this.onProgress?.(payload?.operation ?? "", payload?.message ?? "");
      return;
    }

    if (frame.type === "response" && frame.id) {
      const entry = this.pending.get(frame.id);
      if (!entry) return;
      this.pending.delete(frame.id);
      clearTimeout(entry.timer);
      const payload = frame.payload as ResponsePayload;
      if (payload?.success) {
        entry.resolve(payload.data);
      } else {
        entry.reject(new Error(payload?.error ?? "Runner request failed"));
      }
    }
  }
}
