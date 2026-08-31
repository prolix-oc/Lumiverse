import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { generateRoutes } from "./generate.routes";
import * as generateService from "../services/generate.service";

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  while (spies.length > 0) spies.pop()!.mockRestore();
});

function authenticatedRoutes(userId: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("session", { user: { username: "owner" } } as never);
    await next();
  });
  app.route("/generate", generateRoutes);
  return app;
}

describe("generation Stop request authority", () => {
  test("routes an id-less correlated Stop before chat fallback and reports acceptance", async () => {
    const authorityId = crypto.randomUUID();
    const authorityStop = spyOn(generateService, "stopGenerationRequestAuthority")
      .mockResolvedValue(true);
    const chatStop = spyOn(generateService, "stopChatGenerations")
      .mockResolvedValue(false);
    spies.push(authorityStop, chatStop);

    const response = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: "chat-a", request_authority_id: authorityId }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true, status: "accepted" });
    expect(authorityStop).toHaveBeenCalledWith("user-a", "chat-a", authorityId);
    expect(chatStop).toHaveBeenCalledWith("user-a", "chat-a");
  });
  test("rejects a mismatched authority-generation pair without cancelling either live generation", async () => {
    const authorityA = crypto.randomUUID();
    const authorityB = crypto.randomUUID();
    const owners = new Map<unknown, string>([
      [authorityA, "generation-a"],
      [authorityB, "generation-b"],
    ]);
    const authorityStop = spyOn(generateService, "stopGenerationRequestAuthority")
      .mockImplementation(async (_userId, _chatId, authorityId, expectedGenerationId) => (
        owners.get(authorityId) === expectedGenerationId
      ));
    const exactStop = spyOn(generateService, "stopGeneration").mockResolvedValue(true);
    const chatStop = spyOn(generateService, "stopChatGenerations").mockResolvedValue(true);
    spies.push(authorityStop, exactStop, chatStop);

    const mismatched = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generation_id: "generation-b",
        chat_id: "chat-a",
        request_authority_id: authorityA,
      }),
    });
    expect(mismatched.status).toBe(200);
    expect(await mismatched.json()).toEqual({ stopped: false, status: "not_found" });
    expect(authorityStop).toHaveBeenLastCalledWith("user-a", "chat-a", authorityA, "generation-b");
    expect(exactStop).not.toHaveBeenCalled();
    expect(chatStop).not.toHaveBeenCalled();

    const exact = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generation_id: "generation-b",
        chat_id: "chat-a",
        request_authority_id: authorityB,
      }),
    });
    expect(exact.status).toBe(200);
    expect(await exact.json()).toEqual({ stopped: true, status: "accepted" });
    expect(authorityStop).toHaveBeenLastCalledWith("user-a", "chat-a", authorityB, "generation-b");
    expect(exactStop).not.toHaveBeenCalled();
    expect(chatStop).not.toHaveBeenCalled();
  });
  test("passes owner chat authority to generation-id Stop", async () => {
    const exactStop = spyOn(generateService, "stopGeneration").mockResolvedValue(true);
    spies.push(exactStop);

    const response = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation_id: "turn-a", chat_id: "chat-a" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopped: true, status: "accepted" });
    expect(exactStop).toHaveBeenCalledWith("user-a", "turn-a", "chat-a");
  });
  test("canonical dormant failure outranks optimistic request-authority Stop", async () => {
    const terminal = {
      status: "terminal" as const,
      generationId: "turn-failed",
      run: {
        version: 2 as const,
        status: "terminal" as const,
        turnId: "turn-failed",
        generationId: "turn-failed",
        revision: 4,
        target: { chatId: "chat-a", generationType: "normal", messageId: null, swipeId: null },
        workPhase: "WORK",
        workStatus: "terminal",
        workOutcome: "failed",
        reason: "provider_failure",
        recoveryEligible: true,
        recoveryAction: "retry",
        omissionCount: 0,
        inspectionAttemptId: "turn-failed",
        error: { code: "agentic_provider_failure" },
      },
    } as never;
    const authorityStop = spyOn(generateService, "stopGenerationRequestAuthority").mockResolvedValue(terminal);
    const exactStop = spyOn(generateService, "stopGeneration").mockResolvedValue(true);
    spies.push(authorityStop, exactStop);

    const response = await authenticatedRoutes("user-a").request("/generate/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generation_id: "turn-failed",
        chat_id: "chat-a",
        request_authority_id: "authority-a",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stopped: false,
      status: "terminal",
      terminal: {
        generationId: "turn-failed",
        status: "terminal",
        workOutcome: "failed",
        reason: "provider_failure",
      },
    });
    expect(authorityStop).toHaveBeenCalledWith("user-a", "chat-a", "authority-a", "turn-failed");
    expect(exactStop).not.toHaveBeenCalled();
  });
});
