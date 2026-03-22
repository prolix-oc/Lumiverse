import { Hono } from "hono";
import * as managerSvc from "../spindle/manager.service";
import * as lifecycle from "../spindle/lifecycle";
import { validateOAuthState } from "../spindle/oauth-state";

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const app = new Hono();

const DEFAULT_SUCCESS_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Authorization Complete</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#16213e;border:1px solid #0f3460}
h1{margin:0 0 .5rem;font-size:1.5rem}p{margin:0;opacity:.7}</style></head>
<body><div class="card"><h1>Authorization Complete</h1><p>You can close this window.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;

function errorHtml(title: string, message: string): string {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${safeTitle}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.card{text-align:center;padding:2rem;border-radius:12px;background:#16213e;border:1px solid #e74c3c}
h1{margin:0 0 .5rem;font-size:1.5rem;color:#e74c3c}p{margin:0;opacity:.7}</style></head>
<body><div class="card"><h1>${safeTitle}</h1><p>${safeMessage}</p></div></body></html>`;
}

app.get("/:identifier/callback", async (c) => {
  const identifier = c.req.param("identifier");

  // Validate OAuth state parameter to prevent CSRF
  const state = c.req.query("state");
  if (!state || !validateOAuthState(state, identifier)) {
    return c.html(errorHtml("Invalid State", "OAuth state parameter is missing, expired, or invalid. Please retry the authorization flow."), 400);
  }

  const ext = managerSvc.getExtensionByIdentifier(identifier);
  if (!ext) {
    return c.html(errorHtml("Extension Not Found", `No extension with identifier "${identifier}" is installed.`), 404);
  }

  if (!managerSvc.hasPermission(identifier, "oauth")) {
    return c.html(errorHtml("Permission Denied", "This extension does not have the OAuth permission."), 403);
  }

  if (!lifecycle.isRunning(ext.id)) {
    return c.html(errorHtml("Extension Not Running", "The extension is not currently running."), 503);
  }

  const host = lifecycle.getWorkerHost(ext.id);
  if (!host) {
    return c.html(errorHtml("Extension Not Available", "Could not reach the extension worker."), 503);
  }

  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.req.query())) {
    params[key] = String(value);
  }

  try {
    const result = await host.sendOAuthCallback(params);
    // Extensions cannot supply arbitrary HTML — only a plain-text message
    if (result?.message && typeof result.message === "string") {
      const safeMsg = escapeHtml(result.message);
      const html = DEFAULT_SUCCESS_HTML.replace(
        "<p>You can close this window.</p>",
        `<p>${safeMsg}</p>`
      );
      return c.html(html);
    }
    return c.html(DEFAULT_SUCCESS_HTML);
  } catch (err: any) {
    console.error(`[Spindle OAuth] Callback error for ${identifier}:`, err?.message || err);
    return c.html(errorHtml("Authorization Failed", "The extension encountered an error processing the callback."), 500);
  }
});

export const spindleOAuthRoutes = app;
