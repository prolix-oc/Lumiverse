import type { Context } from "hono";

export function forwardSessionCookies(c: Context, headers: Headers | undefined): void {
  if (!headers) return;

  // A programmatic Better Auth getSession() call can renew the sliding
  // session and emit a replacement session cookie. Unlike auth.handler(),
  // those response headers are not forwarded by Hono automatically.
  const values = typeof (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === "function"
    ? (headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
    : headers.get("set-cookie")
      ? [headers.get("set-cookie")!]
      : [];

  for (const value of values) {
    c.header("Set-Cookie", value, { append: true });
  }
}
