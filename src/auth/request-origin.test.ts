import { describe, expect, test } from "bun:test";
import {
  approvedAuthRequest,
  requestAtResolvedOrigin,
  resolveApprovedOriginFromRequest,
} from "./request-origin";

const allowedHosts = new Set(["127.0.0.1:7860", "app.example.test"]);
const allowedOrigins = new Set([
  "http://127.0.0.1:7860",
  "https://app.example.test",
]);

function resolve(request: Request, trustForwarded: boolean) {
  return resolveApprovedOriginFromRequest(request, {
    trustForwarded,
    fallbackOrigin: "http://localhost:7860",
    isHostAllowed: (host) => allowedHosts.has(host),
    isOriginAllowed: (origin) => allowedOrigins.has(origin),
  });
}

describe("approved auth request origins", () => {
  test("uses a directly approved host", () => {
    expect(resolve(new Request("http://127.0.0.1:7860/api/auth/session"), false))
      .toBe("http://127.0.0.1:7860");
  });

  test("uses forwarded origin only for a trusted proxy", () => {
    const request = new Request("http://127.0.0.1:7860/api/auth/session", {
      headers: {
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
      },
    });
    expect(resolve(request, false)).toBe("http://127.0.0.1:7860");
    expect(resolve(request, true)).toBe("https://app.example.test");
  });

  test("preserves an explicitly approved HTTPS scheme behind TLS termination", () => {
    const request = new Request("http://app.example.test/api/auth/session", {
      headers: { host: "app.example.test" },
    });
    expect(resolve(request, false)).toBe("https://app.example.test");
  });

  test("fails back when either forwarded host or scheme is unapproved", () => {
    const request = new Request("http://127.0.0.1:7860/api/auth/session", {
      headers: {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      },
    });
    expect(resolve(request, true)).toBe("http://localhost:7860");

    const downgrade = new Request("http://127.0.0.1:7860/api/auth/session", {
      headers: {
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "http",
      },
    });
    expect(resolve(downgrade, true)).toBe("http://localhost:7860");
  });

  test("does not fall through from an invalid higher-priority host header", () => {
    const request = new Request("http://127.0.0.1:7860/api/auth/session", {
      headers: { host: "evil.example" },
    });
    expect(resolve(request, false)).toBe("http://localhost:7860");
  });

  test("rewrites the URL and removes identity-sensitive proxy headers", () => {
    const request = new Request("http://127.0.0.1:7860/api/auth/session", {
      headers: {
        host: "127.0.0.1:7860",
        forwarded: "host=evil.example;proto=https",
        "x-forwarded-host": "app.example.test",
        "x-forwarded-proto": "https",
        "x-forwarded-port": "443",
      },
    });
    const rewritten = requestAtResolvedOrigin(
      request,
      "https://app.example.test",
      "/api/auth/session?fresh=1",
    );
    expect(rewritten.url).toBe("https://app.example.test/api/auth/session?fresh=1");
    expect(rewritten.headers.get("host")).toBeNull();
    expect(rewritten.headers.get("forwarded")).toBeNull();
    expect(rewritten.headers.get("x-forwarded-host")).toBeNull();
    expect(rewritten.headers.get("x-forwarded-proto")).toBeNull();
    expect(rewritten.headers.get("x-forwarded-port")).toBeNull();
  });

  test("session lookups leave large upload bodies solely with the route", async () => {
    let pulls = 0;
    const chunks = [new Uint8Array([0x50, 0x4b, 0x03, 0x04]), new Uint8Array([1, 2, 3])];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const request = new Request("http://127.0.0.1:7860/api/v1/user-data/import", {
      method: "POST", body,
      headers: { Cookie: "better-auth.session_token=test", "Content-Length": String(14 * 1024 ** 3) },
    });
    const sessionRequest = approvedAuthRequest(request, false);
    expect(sessionRequest.method).toBe("GET");
    expect(sessionRequest.body).toBeNull();
    expect(sessionRequest.headers.get("content-length")).toBeNull();
    expect(sessionRequest.headers.get("cookie")).toBe("better-auth.session_token=test");
    expect(request.bodyUsed).toBe(false);
    expect(pulls).toBe(0);
    expect(await request.bytes()).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]));
    expect(await sessionRequest.text()).toBe("");
  });

  test("HTTP auth rewrites retain bodies for sign-in and OAuth requests", async () => {
    const body = JSON.stringify({ username: "owner", password: "test-password" });
    const request = new Request("http://127.0.0.1:7860/api/auth/sign-in/username", {
      method: "POST", headers: { "Content-Type": "application/json" }, body,
    });
    const rewritten = requestAtResolvedOrigin(request, "https://app.example.test", "/api/auth/sign-in/username");
    expect(rewritten.method).toBe("POST");
    expect(await rewritten.text()).toBe(body);
  });
});
