import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { LOCAL_INSTANCE_CONNECTION, normalizeRemoteOrigin } from "../src/instance-connection";
import { resolveLocalServerSource } from "../src/local-server";

const desktopRoot = new URL("../", import.meta.url);
const html = await Bun.file(new URL("custom-url.html", desktopRoot)).text();
const css = await Bun.file(new URL("src/custom-url.css", desktopRoot)).text();
const script = await Bun.file(new URL("src/custom-url.ts", desktopRoot)).text();
const executable = new Bun.Transpiler({ loader: "ts", target: "browser" })
  .transformSync(script).replace(/^import[\s\S]*?;\s*/gm, "");

async function until(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Instance selector did not finish");
    await Bun.sleep(1);
  }
}

function ui(options: {
  settings?: Record<string, unknown>;
  load?: Promise<Record<string, unknown>>;
  bundled?: boolean;
  validCheckout?: boolean;
  bun?: string | null;
} = {}) {
  const dom = new JSDOM(html, { url: "http://localhost:1430/custom-url.html", pretendToBeVisual: true });
  const style = dom.window.document.createElement("style");
  style.textContent = css;
  dom.window.document.head.append(style);
  const emitted: unknown[] = [];
  const calls: string[] = [];
  let closed = false;
  const settings = {
    instanceConnection: LOCAL_INSTANCE_CONNECTION, instanceConnectionConfigured: false,
    savedRemoteConnection: null, repoDir: null, bunPath: null, localServerSource: null,
    ...options.settings,
  };
  const invoke = async (command: string) => {
    calls.push(command);
    switch (command) {
      case "bundled_server_available": return options.bundled ?? true;
      case "validate_repo": return options.validCheckout ?? true;
      case "resolve_bun": return options.bun === undefined ? "/tools/bun" : options.bun;
      case "pick_folder": return "/existing/lumiverse";
      default: throw new Error(`Unexpected native callback: ${command}`);
    }
  };
  new Function("document", "window", "requestAnimationFrame", "invoke", "emit", "getCurrentWindow", "loadSettings", "resolveLocalServerSource", "LOCAL_INSTANCE_CONNECTION", "normalizeRemoteOrigin", executable)(
    dom.window.document, dom.window, (callback: () => void) => callback(), invoke,
    async (_event: string, selection: unknown) => { emitted.push(selection); },
    () => ({ close: async () => { closed = true; } }), () => options.load ?? Promise.resolve(settings),
    resolveLocalServerSource, LOCAL_INSTANCE_CONNECTION, normalizeRemoteOrigin,
  );
  const document = dom.window.document;
  const ready = () => until(() => !(document.querySelector("#save") as HTMLButtonElement).disabled);
  const choose = (value: string) => {
    const input = document.querySelector(`input[value="${value}"]`) as HTMLInputElement;
    input.checked = true;
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  };
  const submit = () => document.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  return { dom, document, emitted, calls, ready, choose, submit, closed: () => closed };
}

describe("instance connection selector", () => {
  test("choosing the built-in server leaves a saved checkout folder out of its setup", async () => {
    const view = ui({ settings: { repoDir: "/existing/lumiverse", instanceConnectionConfigured: true } });
    try {
      await view.ready();
      view.choose("bundled");
      view.submit();
      await until(view.closed);
      expect(view.emitted).toEqual([{ connection: { mode: "local" }, localServerSource: "bundled" }]);
      expect(view.calls).toEqual(["bundled_server_available"]);
      expect((view.document.querySelector("#checkout-folder") as HTMLInputElement).value).toBe("/existing/lumiverse");
    } finally { view.dom.window.close(); }
  });

  test("fresh profiles offer three paths and checkout reuse validates native settings", async () => {
    const view = ui();
    try {
      await view.ready();
      expect(view.document.querySelector("h1")!.textContent).toBe("Welcome to Lumiverse");
      expect(view.document.querySelectorAll('input[name="connection-mode"]')).toHaveLength(3);
      view.choose("checkout");
      expect(view.document.querySelector("#checkout-settings")!.hasAttribute("hidden")).toBe(false);
      expect(view.document.querySelector("#remote-settings")!.hasAttribute("hidden")).toBe(true);
      (view.document.querySelector("#browse-checkout") as HTMLButtonElement).click();
      await until(() => (view.document.querySelector("#checkout-folder") as HTMLInputElement).value !== "");
      view.submit();
      await until(view.closed);
      expect(view.emitted).toEqual([{
        connection: { mode: "local" }, localServerSource: "checkout",
        repoDir: "/existing/lumiverse", bunPath: "/tools/bun",
      }]);
      expect(view.calls).toEqual(["bundled_server_available", "pick_folder", "validate_repo", "resolve_bun"]);
    } finally { view.dom.window.close(); }
  });

  test("saved checkout users keep their folder selected when installing a bundled app", async () => {
    const view = ui({ settings: { repoDir: "/existing/lumiverse", instanceConnectionConfigured: true } });
    try {
      await view.ready();
      expect((view.document.querySelector('input[value="checkout"]') as HTMLInputElement).checked).toBe(true);
      expect((view.document.querySelector("#checkout-folder") as HTMLInputElement).value).toBe("/existing/lumiverse");
      expect(view.document.querySelector("h1")!.textContent).toBe("Instance connection");
    } finally { view.dom.window.close(); }
  });

  test("remote URLs and identity remain available while a checkout is active", async () => {
    const remote = { mode: "remote", origin: "https://example.com", instanceId: "original", displayName: "Original" };
    const view = ui({ settings: { repoDir: "/existing/lumiverse", savedRemoteConnection: remote } });
    try {
      await view.ready();
      view.choose("remote");
      view.submit();
      await until(view.closed);
      expect(view.emitted).toEqual([{ connection: remote }]);
      expect(view.calls).toEqual(["bundled_server_available"]);
    } finally { view.dom.window.close(); }
  });

  test("missing Bun or an invalid checkout stays in the chooser and does not save a selection", async () => {
    for (const options of [{ validCheckout: false }, { bun: null }]) {
      const view = ui(options);
      try {
        await view.ready();
        view.choose("checkout");
        (view.document.querySelector("#checkout-folder") as HTMLInputElement).value = "/existing/lumiverse";
        view.submit();
        await view.ready();
        expect(view.emitted).toEqual([]);
        expect(view.closed()).toBe(false);
        expect(view.document.querySelector("#error")!.hasAttribute("hidden")).toBe(false);
      } finally { view.dom.window.close(); }
    }
  });

  test("checkout-only builds hide the built-in choice", async () => {
    const view = ui({ bundled: false });
    try {
      await view.ready();
      const builtin = view.document.querySelector('[data-connection-option="bundled"]')!;
      expect(view.dom.window.getComputedStyle(builtin).display).toBe("none");
      expect((view.document.querySelector('input[value="checkout"]') as HTMLInputElement).checked).toBe(true);
    } finally { view.dom.window.close(); }
  });

  test("loading stored settings does not overwrite a user's early choice or typed URL", async () => {
    let restore!: (settings: Record<string, unknown>) => void;
    const view = ui({ load: new Promise((resolve) => { restore = resolve; }) });
    try {
      view.choose("remote");
      const input = view.document.querySelector("#frontend-url") as HTMLInputElement;
      input.value = "https://new.example.com";
      input.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
      restore({ repoDir: "/old/checkout", instanceConnection: { mode: "local" }, instanceConnectionConfigured: true });
      await view.ready();
      expect((view.document.querySelector('input[value="remote"]') as HTMLInputElement).checked).toBe(true);
      expect(input.value).toBe("https://new.example.com");
    } finally { view.dom.window.close(); }
  });

  test("uses full-card native radio targets instead of label-only activation", () => {
    expect(html).toContain('for="connection-mode-local"');
    expect(html).toContain('id="connection-mode-local"');
    expect(html).toContain('for="connection-mode-remote"');
    expect(html).toContain('id="connection-mode-remote"');

    const inputRule = css.match(/\.connection-option > input \{([^}]*)\}/)?.[1] ?? "";
    expect(inputRule).toContain("inset: 0");
    expect(inputRule).toContain("width: 100%");
    expect(inputRule).toContain("height: 100%");
    expect(inputRule).not.toContain("pointer-events: none");
  });

  test("wires mode changes before loading persisted settings", () => {
    const changeListener = script.indexOf('option.addEventListener("change"');
    const settingsLoad = script.indexOf("await loadSettings()");

    expect(changeListener).toBeGreaterThan(-1);
    expect(settingsLoad).toBeGreaterThan(-1);
    expect(changeListener).toBeLessThan(settingsLoad);
    expect(css).not.toContain(":has(");
  });
});
