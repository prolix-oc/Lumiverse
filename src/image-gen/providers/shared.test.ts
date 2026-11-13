import { afterEach, expect, test } from "bun:test";
import { toDataUrl } from "./shared";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("provider results cannot read server-local files through Bun fetch", async () => {
  let fetched = false;
  globalThis.fetch = (async () => { fetched = true; return new Response("private"); }) as unknown as typeof fetch;
  for (const url of ["file:///tmp/private-image.png", "FILE:///tmp/private-image.png", "ftp://example.test/image.png"]) {
    await expect(toDataUrl(url)).rejects.toThrow("HTTP or HTTPS");
  }
  expect(fetched).toBe(false);
});

test("inline images are retained without fetching", async () => {
  const url = "data:image/png;base64,QUJD";
  expect(await toDataUrl(url)).toBe(url);
});
