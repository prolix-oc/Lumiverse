import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { username } from "better-auth/plugins";
import { CookieJar } from "jsdom";
import { requestCookiePolicy } from "./request-cookies";

const database = new Database(":memory:");
const options = {
  database,
  secret: "isolated-browser-cookie-regression-test-secret",
  baseURL: { allowedHosts: ["localhost:17860", "remote.example.test"], protocol: "auto", fallback: "http://localhost:17860" },
  trustedOrigins: ["http://localhost:17860", "https://remote.example.test"],
  emailAndPassword: { enabled: true }, plugins: [username()],
  hooks: { before: requestCookiePolicy },
} satisfies BetterAuthOptions;
await (await getMigrations(options)).runMigrations();
const auth = betterAuth(options);
afterAll(() => database.close());

const jar = new CookieJar(undefined, { allowSecureOnLocal: false, prefixSecurity: "strict" });
const password = "cookie-regression-test-password";
await auth.api.signUpEmail({ body: { email: "owner@example.test", name: "Owner", username: "owner", password } });

async function signIn(origin: string) {
  const response = await auth.handler(new Request(`${origin}/api/auth/sign-in/username`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username: "owner", password }),
  }));
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  for (const cookie of cookies) await jar.setCookie(cookie, origin);
  return cookies;
}

test("HTTP login keeps a browser session through HTTP and direct API checks", async () => {
  const origin = "http://localhost:17860";
  const cookies = await signIn(origin);
  expect(cookies.some((cookie) => cookie.startsWith("better-auth.session_token="))).toBe(true);
  expect(cookies.some((cookie) => /;\s*Secure(?:;|$)/i.test(cookie))).toBe(false);
  const cookie = await jar.getCookieString(origin);
  expect(cookie).toContain("better-auth.session_token=");
  const request = new Request(`${origin}/api/auth/get-session`, { headers: { Cookie: cookie } });
  const response = await auth.handler(request);
  expect((await response.json()).user.username).toBe("owner");
  const direct = await auth.api.getSession({ request, headers: request.headers, asResponse: false, returnHeaders: true });
  expect(direct.response?.user.username).toBe("owner");
});

test("HTTPS sessions retain Secure cookies and coexist with the local instance", async () => {
  const origin = "https://remote.example.test";
  const cookies = await signIn(origin);
  expect(cookies.some((cookie) => cookie.startsWith("__Secure-better-auth.session_token="))).toBe(true);
  expect(cookies.some((cookie) => /;\s*Secure(?:;|$)/i.test(cookie))).toBe(true);
  const remoteCookie = await jar.getCookieString(origin);
  const request = new Request(`${origin}/api/auth/get-session`, { headers: { Cookie: remoteCookie } });
  expect((await auth.api.getSession({ request, headers: request.headers, asResponse: false }))?.user.username).toBe("owner");
  expect(await jar.getCookieString("http://localhost:17860")).not.toContain("__Secure-");
  expect(remoteCookie).not.toContain("; better-auth.session_token=");
});
