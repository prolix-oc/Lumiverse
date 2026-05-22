import { afterEach, describe, expect, test } from "bun:test";

import {
  readSharedRpcEndpoint,
  registerSharedRpcRequestEndpoint,
  resetSharedRpcPoolForTests,
  syncSharedRpcEndpoint,
  unregisterSharedRpcEndpoint,
  unregisterSharedRpcEndpointsByOwner,
} from "./shared-rpc-pool.service";
import {
  assertValidSharedRpcEndpoint,
  normalizeOwnedSharedRpcEndpoint,
} from "./shared-rpc";

afterEach(() => {
  resetSharedRpcPoolForTests();
});

describe("shared RPC endpoint validation", () => {
  test("prefixes owner-defined channel names", () => {
    expect(normalizeOwnedSharedRpcEndpoint("weather_ext", "status.current")).toBe(
      "weather_ext.status.current"
    );
  });

  test("nests full-looking channel names under the owner prefix", () => {
    expect(normalizeOwnedSharedRpcEndpoint("weather_ext", "other_ext.status")).toBe(
      "weather_ext.other_ext.status"
    );
  });

  test("rejects invalid reader endpoints", () => {
    expect(() => assertValidSharedRpcEndpoint("WeatherExt.status")).toThrow(
      'Invalid shared RPC endpoint "WeatherExt.status"'
    );
  });
});

describe("shared RPC pool", () => {
  test("returns the latest synced value", async () => {
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true, temp: 72 });
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true, temp: 73 });

    await expect(readSharedRpcEndpoint("weather_ext.status.current", "reader_ext")).resolves.toEqual({
      ok: true,
      temp: 73,
    });
  });

  test("invokes on-request endpoints", async () => {
    registerSharedRpcRequestEndpoint("weather_ext", "status.live", async (requesterExtensionId) => ({
      requesterExtensionId,
      temp: 74,
    }));

    await expect(readSharedRpcEndpoint("weather_ext.status.live", "reader_ext")).resolves.toEqual({
      requesterExtensionId: "reader_ext",
      temp: 74,
    });
  });

  test("gracefully rejects unknown endpoints", async () => {
    await expect(readSharedRpcEndpoint("weather_ext.status.missing", "reader_ext")).rejects.toThrow(
      'Shared RPC endpoint "weather_ext.status.missing" is not registered'
    );
  });

  test("allows reads when requester inherits owner permissions", async () => {
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true });

    const permissions = new Map([
      ["weather_ext", ["chats", "images"]],
      ["reader_ext", ["chats", "images", "tools"]],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.current",
        "reader_ext",
        (extensionIdentifier) => permissions.get(extensionIdentifier) || []
      )
    ).resolves.toEqual({ ok: true });
  });

  test("rejects reads when requester lacks owner permissions", async () => {
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true });

    const permissions = new Map([
      ["weather_ext", ["chats", "images"]],
      ["reader_ext", ["chats"]],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.current",
        "reader_ext",
        (extensionIdentifier) => permissions.get(extensionIdentifier) || []
      )
    ).rejects.toThrow(
      'Shared RPC endpoint "weather_ext.status.current" requires requester "reader_ext" to inherit owner "weather_ext" permissions: images'
    );
  });

  test("allows explicit public reads without inheriting unrelated owner permissions", async () => {
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true }, { requires: [] });

    const permissions = new Map([
      ["weather_ext", ["images"]],
      ["reader_ext", ["generation"]],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.current",
        "reader_ext",
        (extensionIdentifier) => permissions.get(extensionIdentifier) || []
      )
    ).resolves.toEqual({ ok: true });
  });

  test("checks explicit endpoint permissions against requester and owner", async () => {
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true }, { requires: ["images"] });

    const requesterMissing = new Map([
      ["weather_ext", ["images"]],
      ["reader_ext", ["generation"]],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.current",
        "reader_ext",
        (extensionIdentifier) => requesterMissing.get(extensionIdentifier) || []
      )
    ).rejects.toThrow('requires requester "reader_ext" permissions: images');

    const ownerMissing = new Map([
      ["weather_ext", []],
      ["reader_ext", ["images"]],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.current",
        "reader_ext",
        (extensionIdentifier) => ownerMissing.get(extensionIdentifier) || []
      )
    ).rejects.toThrow('requires owner "weather_ext" permissions: images');
  });

  test("passes only explicit endpoint permissions to on-request handlers", async () => {
    registerSharedRpcRequestEndpoint(
      "weather_ext",
      "status.live",
      async (_requesterExtensionId, effectivePermissions) => ({ effectivePermissions }),
      { requires: ["generation"] }
    );

    const permissions = new Map([
      ["weather_ext", ["generation", "images"]],
      ["reader_ext", ["generation", "chats"]],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.live",
        "reader_ext",
        (extensionIdentifier) => permissions.get(extensionIdentifier) || []
      )
    ).resolves.toEqual({ effectivePermissions: ["generation"] });
  });

  test("applies permission inheritance before invoking on-request endpoints", async () => {
    let invoked = false;
    registerSharedRpcRequestEndpoint("weather_ext", "status.live", async () => {
      invoked = true;
      return { ok: true };
    });

    const permissions = new Map([
      ["weather_ext", ["generation"]],
      ["reader_ext", []],
    ]);

    await expect(
      readSharedRpcEndpoint(
        "weather_ext.status.live",
        "reader_ext",
        (extensionIdentifier) => permissions.get(extensionIdentifier) || []
      )
    ).rejects.toThrow("requires requester");
    expect(invoked).toBe(false);
  });

  test("removes endpoints on unregister and owner cleanup", async () => {
    syncSharedRpcEndpoint("weather_ext", "status.current", { ok: true });
    registerSharedRpcRequestEndpoint("weather_ext", "status.live", async () => ({ ok: true }));

    unregisterSharedRpcEndpoint("weather_ext", "status.current");
    await expect(readSharedRpcEndpoint("weather_ext.status.current", "reader_ext")).rejects.toThrow(
      'Shared RPC endpoint "weather_ext.status.current" is not registered'
    );

    unregisterSharedRpcEndpointsByOwner("weather_ext");
    await expect(readSharedRpcEndpoint("weather_ext.status.live", "reader_ext")).rejects.toThrow(
      'Shared RPC endpoint "weather_ext.status.live" is not registered'
    );
  });
});
