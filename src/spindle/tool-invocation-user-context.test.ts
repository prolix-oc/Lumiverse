import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionInfo, HostToWorker, SpindleManifest } from "lumiverse-spindle-types";
import { WorkerHost } from "./worker-host";

function manifest(identifier: string): SpindleManifest {
  return {
    identifier,
    name: identifier,
    version: "1.0.0",
    author: "test",
    description: "",
  } as SpindleManifest;
}

function extensionInfo(id: string): ExtensionInfo {
  return {
    id,
    identifier: id,
    name: id,
    version: "0.0.0",
    author: "",
    description: "",
    github: "",
    homepage: "",
    permissions: [],
    granted_permissions: [],
    enabled: true,
    installed_at: 0,
    updated_at: 0,
    has_frontend: false,
    has_backend: false,
    status: "stopped",
    metadata: { install_scope: "operator", installed_by_user_id: "operator" },
  };
}

function attachRuntime(host: WorkerHost): HostToWorker[] {
  const posted: HostToWorker[] = [];
  (host as unknown as { runtime: { mode: string; pid: null; postMessage(message: HostToWorker): void; terminate(): void } }).runtime = {
    mode: "worker",
    pid: null,
    postMessage(message) { posted.push(message); },
    terminate() {},
  };
  return posted;
}

function handle(host: WorkerHost, message: unknown): void {
  (host as unknown as { handleMessage(msg: unknown): void }).handleMessage(message);
}

describe("tool invocation user context", () => {
  test("fails closed before posting when authenticated user context is missing", async () => {
    const host = new WorkerHost("inst-pocket", manifest("pocket"), extensionInfo("pocket"));
    const posted = attachRuntime(host);

    await expect(host.invokeExtensionTool("phone_action", { action: "send_message" }, 1_000, "")).rejects.toThrow(
      /requires authenticated user context/,
    );
    expect(posted).toHaveLength(0);
  });

  test("forwards authenticated user context separately and strips model spoof fields", async () => {
    const host = new WorkerHost("inst-pocket", manifest("pocket"), extensionInfo("pocket"));
    const posted = attachRuntime(host);

    const pending = host.invokeExtensionTool(
      "phone_action",
      {
        userId: "model-spoof",
        __userId: "model-spoof-2",
        __user_id: "model-spoof-3",
        action: "send_message",
      },
      1_000,
      "authenticated-user",
    );

    const invocation = posted.find((message) => message.type === "tool_invocation");
    expect(invocation).toBeDefined();
    if (!invocation || invocation.type !== "tool_invocation") throw new Error("tool invocation was not posted");

    expect(invocation.userId).toBe("authenticated-user");
    expect(invocation.args.action).toBe("send_message");
    expect("userId" in invocation.args).toBe(false);
    expect("__userId" in invocation.args).toBe(false);
    expect("__user_id" in invocation.args).toBe(false);

    handle(host, {
      type: "tool_invocation_result",
      requestId: invocation.requestId,
      result: "ok",
    });
    await expect(pending).resolves.toBe("ok");
  });

  test("keeps authenticated context wired across both callers, council runtime, host, and worker", async () => {
    const generateSource = await readFile(join(import.meta.dir, "../services/generate.service.ts"), "utf8");
    const councilExecutionSource = await readFile(join(import.meta.dir, "../services/council/council-execution.service.ts"), "utf8");
    const toolRuntimeSource = await readFile(join(import.meta.dir, "../services/council/tool-runtime.ts"), "utf8");
    const workerHostSource = await readFile(join(import.meta.dir, "./worker-host.ts"), "utf8");
    const workerRuntimeSource = await readFile(join(import.meta.dir, "./worker-runtime.ts"), "utf8");

    expect(generateSource).toMatch(/invokeExtensionCouncilTool\([\s\S]{0,900}?timeoutMs,\s*userId,\s*memberContext,/);
    expect(councilExecutionSource).toMatch(/invokeExtensionCouncilTool\([\s\S]{0,900}?settings\.toolsSettings\.timeoutMs,\s*input\.userId,\s*memberContext,/);
    expect(toolRuntimeSource).toContain("host.invokeExtensionTool(toolName, args, timeoutMs, userId, councilMember, contextMessages)");
    expect(workerHostSource).toMatch(/type:\s*["']tool_invocation["'][\s\S]{0,300}?args:\s*sanitizedArgs,[\s\S]{0,100}?userId,/);
    expect(workerRuntimeSource).toContain("handler(payload, msg.userId)");
  });
});
