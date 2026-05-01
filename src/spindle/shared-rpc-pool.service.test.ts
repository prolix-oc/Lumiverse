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
