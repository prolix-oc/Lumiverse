import { isAbsolute } from "node:path";
import { validateSettings, type BundledServerSettings, type ServerBundleManifest } from "./bundle";

/** Private stdio callbacks for a native parent; no HTTP listener or browser. */
export class BundleDesktopChannel {
  private token = process.env.LUMIVERSE_DESKTOP_CHANNEL_TOKEN || "";
  private buffer = "";
  private closed = false;
  private saving = false;
  private setupState = "starting";
  private configured!: (settings: BundledServerSettings) => void;
  readonly configuration = new Promise<BundledServerSettings>((resolve) => { this.configured = resolve; });
  private snapshot: Record<string, unknown>;
  private defaults: BundledServerSettings;
  private save: (settings: BundledServerSettings, username: unknown, password: unknown) => Promise<void>;
  private stop: () => void;

  constructor(defaults: BundledServerSettings, manifest: ServerBundleManifest,
    save: (settings: BundledServerSettings, username: unknown, password: unknown) => Promise<void>, stop: () => void) {
    if (this.token.length < 16) throw new Error("Desktop mode requires its native parent's private channel token.");
    this.defaults = defaults; this.save = save; this.stop = stop;
    this.snapshot = { state: "starting", pid: null, startedAt: null, port: defaults.port,
      branch: manifest.branch, version: manifest.version, updateAvailable: false, commitsBehind: 0, latestUpdateMessage: "" };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", this.onData);
    process.stdin.on("end", this.onEnd);
    this.emit("status", { status: this.snapshot });
  }
  private emit(type: string, data: Record<string, unknown>) {
    process.stdout.write("\x1e" + JSON.stringify({ token: this.token, type, ...data }) + "\n");
  }
  needsSetup() { this.setupState = "setup"; this.emit("setup", { defaults: this.defaults }); }
  ready(url: string, pid: number) {
    this.setupState = "ready";
    this.snapshot = { ...this.snapshot, state: "running", url, pid, startedAt: Date.now() };
    this.emit("status", { status: this.snapshot });
  }
  private onEnd = () => { if (!this.closed) this.stop(); };
  private onData = (chunk: string) => {
    this.buffer += chunk;
    if (this.buffer.length > 65_536) { this.stop(); return; }
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      void this.receive(line);
    }
  };
  private async receive(line: string) {
    let request: { id?: string; type?: string; payload?: Record<string, unknown> };
    try { request = JSON.parse(line); } catch { return; }
    if (!request || typeof request.id !== "string" || request.id.length > 100) return;
    try {
      let data: unknown = null;
      switch (request.type) {
        case "defaults": data = this.defaults; break;
        case "status": data = { ...this.snapshot, setupState: this.setupState }; break;
        case "configure": {
          if (this.setupState !== "setup" || this.saving) throw new Error("Setup has already started.");
          this.saving = true;
          try {
            const input = request.payload || {};
            if (input.host !== "127.0.0.1" && input.host !== "::") throw new Error("Choose local access or network access.");
            if (typeof input.dataDir !== "string" || !isAbsolute(input.dataDir)) throw new Error("Choose an absolute data folder.");
            const settings = validateSettings({ format: 1, ...input });
            await this.save(settings, input.username, input.password);
            this.defaults = settings;
            this.snapshot.port = settings.port;
            this.setupState = "starting";
            this.configured(settings);
            data = { ok: true };
          } finally { this.saving = false; }
          break;
        }
        case "shutdown":
          this.emit("response", { id: request.id, success: true, data: null });
          this.setupState = "stopping"; this.snapshot.state = "stopping";
          this.emit("status", { status: this.snapshot });
          this.stop(); return;
        default: throw new Error("Unknown desktop command.");
      }
      this.emit("response", { id: request.id, success: true, data });
    } catch (error) {
      this.emit("response", { id: request.id, success: false, error: error instanceof Error ? error.message : "Command failed." });
    }
  }
  close() {
    this.closed = true;
    process.stdin.off("data", this.onData); process.stdin.off("end", this.onEnd); process.stdin.pause();
  }
}
