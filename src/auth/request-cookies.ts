import { createAuthMiddleware } from "better-auth/api";
import { createCookieGetter, getCookies } from "better-auth/cookies";

/** Dynamic origins need cookies for the resolved transport, including direct session API calls. */
export const requestCookiePolicy = createAuthMiddleware(async (ctx) => {
  // Better Auth 1.7 keeps its startup cookies when resolving a dynamic baseURL
  // without cross-subdomain sharing. In production that gives HTTP instances
  // __Secure- cookies that WebKit cannot retain. The context is already scoped
  // to the validated request origin; preserve all other configured attributes.
  const options = { ...ctx.context.options, baseURL: ctx.context.baseURL };
  ctx.context.authCookies = getCookies(options);
  ctx.context.createAuthCookie = createCookieGetter(options);
});
