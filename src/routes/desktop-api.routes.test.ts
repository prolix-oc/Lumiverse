import { describe, expect, test } from "bun:test";
import {
  createDesktopApiRoutes,
  type DesktopApiDependencies,
  type DesktopPrincipal,
} from "./desktop-api.routes";

function fixture(role: string, clientId = "lumiverse-desktop", getPresence?: DesktopApiDependencies["getPresence"]) {
  const principal: DesktopPrincipal = {
    id: "user-1",
    name: "Desktop User",
    email: "desktop@example.test",
    username: "desktop",
    role,
  };
  const dependencies: DesktopApiDependencies = {
    verify: async () => ({ sub: principal.id, azp: clientId }),
    loadPrincipal: () => principal,
    getStatus: async () => ({ pid: 42, version: "1.2.3" }),
    getInstance: () => ({ id: "lvdi_test", name: "example.test" }),
    getPresence,
  };
  return createDesktopApiRoutes(dependencies);
}

describe("desktop OAuth API", () => {
  test("authenticates an ordinary user but marks status as restricted", async () => {
    const app = fixture("user");
    const me = await app.request("/me", { headers: { authorization: "Bearer token" } });
    const status = await app.request("/status", { headers: { authorization: "Bearer token" } });

    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      account: { role: "user" },
      capabilities: { canReadStatus: false },
    });
    expect(status.status).toBe(403);
    expect(await status.json()).toMatchObject({ code: "ROLE_REQUIRED" });
  });

  test("returns status to administrators and owners", async () => {
    for (const role of ["admin", "owner"]) {
      const response = await fixture(role).request("/status", {
        headers: { authorization: "Bearer token" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ pid: 42, version: "1.2.3" });
    }
  });

  test("rejects a token issued to another OAuth client", async () => {
    const response = await fixture("owner", "another-client").request("/me", {
      headers: { authorization: "Bearer token" },
    });
    expect(response.status).toBe(401);
  });

  test("returns the active chat presence snapshot", async () => {
    const response = await fixture("user", "lumiverse-desktop", async (userId) =>
      userId === "user-1"
        ? {
            chatId: "chat-9",
            characterName: "Aria",
            messageCount: 142,
            totalTokens: 56780,
            model: "claude-sonnet-4-5",
          }
        : null,
    ).request("/presence", { headers: { authorization: "Bearer token" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: {
        chatId: "chat-9",
        characterName: "Aria",
        messageCount: 142,
        totalTokens: 56780,
        model: "claude-sonnet-4-5",
      },
    });
  });

  test("clears activity when no presence snapshot is available", async () => {
    const response = await fixture("user", "lumiverse-desktop", () => null).request("/presence", {
      headers: { authorization: "Bearer token" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ active: null });
  });

  test("returns the authenticated user's landing activity and character count", async () => {
    const response = await fixture("user", "lumiverse-desktop", async (userId) => {
      expect(userId).toBe("user-1");
      return {
        chatId: null, characterName: null, messageCount: null,
        totalTokens: null, model: null, characterCount: 24,
      };
    }).request("/presence", { headers: { authorization: "Bearer token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      active: {
        chatId: null, characterName: null, messageCount: null,
        totalTokens: null, model: null, characterCount: 24,
      },
    });
  });
});
