import { describe, expect, test } from "bun:test";

const capability = await Bun.file(
  new URL("../src-tauri/capabilities/frontend-titlebar.json", import.meta.url),
).json();

// Tauri matches remote capability URLs using the URLPattern standard.
// A hostname wildcard alone does not include non-default ports.
const patterns = capability.remote.urls.map((url: string) => new URLPattern(url));
const allows = (url: string) => patterns.some((pattern: URLPattern) => pattern.test(url));

describe("frontend titlebar remote origins", () => {
  test("screen capture setup is limited to the primary frontend, without native controls", async () => {
    expect(capability.windows).toEqual(["frontend"]);
    expect(capability.permissions).toContain("desktop-capture-setup");
    expect(capability.permissions).not.toContain("desktop-capture-controls");
    expect(capability.permissions).toContain("desktop-keybindings-frontend");
    expect(capability.permissions).not.toContain("desktop-keybindings-settings");
    expect(capability.permissions.some((permission: string) => permission.startsWith("global-shortcut:"))).toBe(false);
    const permissions = await Bun.file(new URL("../src-tauri/permissions/desktop-capture.toml", import.meta.url)).text();
    const setup = Bun.TOML.parse(permissions).permission.find((entry: { identifier: string }) => entry.identifier === "desktop-capture-setup");
    expect(setup.commands.allow).toEqual(["desktop_capture_request_setup"]);
    const keybindingPermissions = Bun.TOML.parse(await Bun.file(new URL("../src-tauri/permissions/keybindings.toml", import.meta.url)).text()).permission;
    const frontendBindings = keybindingPermissions.find((entry: { identifier: string }) => entry.identifier === "desktop-keybindings-frontend");
    expect(frontendBindings.commands.allow).toContain("desktop_keybindings_frontend_save");
    expect(frontendBindings.commands.allow).toContain("desktop_keybindings_global_permission");
    expect(frontendBindings.commands.allow).not.toContain("desktop_keybindings_save");
  });
  test.each([
    "https://lumiverse.example:8444/",
    "https://lumiverse.example:8444/chat/123?view=chat",
    "http://192.168.1.20:7860/",
    "http://localhost:3000/",
    "http://127.0.0.1:3000/",
    "https://lumiverse.example/",
    "http://lumiverse.example/",
  ])("allows window controls for %s", (url) => {
    expect(allows(url)).toBe(true);
  });

  test.each([
    "ftp://lumiverse.example:8444/",
    "file:///tmp/index.html",
    "tauri://localhost/",
  ])("does not grant remote access to %s", (url) => {
    expect(allows(url)).toBe(false);
  });
});

const popupCapability = await Bun.file(
  new URL("../src-tauri/capabilities/frontend-sso-popup.json", import.meta.url),
).json();
const popupPatterns = popupCapability.remote.urls.map((url: string) => new URLPattern(url));

describe("frontend sign-in popup remote origins", () => {
  test.each([
    "https://lumiverse.example:8444/api/v1/openrouter/oauth-landing",
    "http://192.168.1.20:7860/api/v1/nanogpt/oauth-landing",
    "http://localhost:3000/sso-complete",
    "https://lumiverse.example/sso-complete",
  ])("allows native popup close for %s", (url) => {
    expect(popupPatterns.some((pattern: URLPattern) => pattern.test(url))).toBe(true);
  });
  test("only grants popup close to native frontend popups", () => {
    expect(popupCapability.windows).toEqual(["frontend-popup-*"]);
    expect(popupCapability.permissions).toEqual(["desktop-sso-popup-close"]);
    expect(popupPatterns.some((pattern: URLPattern) => pattern.test('file:///tmp/callback.html'))).toBe(false);
  });
});
