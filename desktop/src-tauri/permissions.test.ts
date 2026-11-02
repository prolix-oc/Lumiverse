import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

/**
 * A Tauri command is only callable when two separate things are true: it is
 * registered in `generate_handler!`, and a capability that reaches the calling
 * window grants it. Rust enforces the first at compile time and nothing
 * enforces the second, so a command can be registered, invoked, and silently
 * denied at runtime — the control simply does nothing.
 *
 * These tests close the gap left by Rust's command registration checks: a
 * registered command without a matching permission is denied only at runtime.
 */

const HERE = import.meta.dir;
const PERMISSIONS_DIR = join(HERE, "permissions");
const CAPABILITIES_DIR = join(HERE, "capabilities");

function readSource(name: string): string {
  return readFileSync(join(HERE, "src", name), "utf8").replace(/\r\n/g, "\n");
}

/** Commands exposed to the webview via `generate_handler!`. */
function registeredCommands(): string[] {
  const lib = readSource("lib.rs");
  const block = lib.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!block) throw new Error("generate_handler! block not found in lib.rs");
  return [...block[1].matchAll(/(?:\b[a-z_][a-z0-9_]*::)+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]);
}

/** Every command name appearing in any `commands.allow` list. */
function permittedCommands(): Set<string> {
  const names = new Set<string>();
  for (const file of readdirSync(PERMISSIONS_DIR).filter((f) => f.endsWith(".toml"))) {
    const toml = readFileSync(join(PERMISSIONS_DIR, file), "utf8");
    for (const list of toml.matchAll(/commands\.allow\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const entry of list[1].matchAll(/"([a-z0-9_]+)"/g)) names.add(entry[1]);
    }
  }
  return names;
}

function capabilities(): Array<{ file: string; json: Record<string, unknown> }> {
  return readdirSync(CAPABILITIES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      file,
      json: JSON.parse(readFileSync(join(CAPABILITIES_DIR, file), "utf8")),
    }));
}

describe("tauri command registration", () => {
  test("every registered command is granted by some permission", () => {
    const permitted = permittedCommands();
    const orphaned = registeredCommands().filter((name) => !permitted.has(name));
    // A registered-but-unpermitted command compiles, invokes, and is denied at
    // runtime with no error surfaced to the user.
    expect(orphaned).toEqual([]);
  });

  test("every permitted command is actually registered", () => {
    const registered = new Set(registeredCommands());
    const dangling = [...permittedCommands()].filter((name) => !registered.has(name));
    // A permission naming a command that no longer exists is dead grant surface
    // and hides a rename.
    expect(dangling).toEqual([]);
  });

  test("the stale-shell command remains covered", () => {
    const permitted = permittedCommands();
    // Regression pins: desktop_shell_sha was registered but unpermitted, which
    // silently disabled the stale-shell check entirely.
    expect(permitted.has("desktop_shell_sha")).toBe(true);
  });

  test("capture commands are explicitly included in the application ACL manifest", () => {
    const build = readFileSync(join(HERE, "build.rs"), "utf8");
    expect(build).toContain("AppManifest::new().commands(");
    for (const command of registeredCommands().filter((name) => name.startsWith("desktop_capture_"))) {
      expect(build).toContain(`"${command}"`);
    }
  });
});

describe("capability origins", () => {
  test("short-lived authorization links stay in the bundled UI and exact Vite control pages", () => {
    const grants = capabilities().filter((capability) =>
      (capability.json.permissions as string[]).includes("desktop-authorization-ui"));
    expect(grants.length).toBe(2);
    for (const capability of grants) {
      if (capability.json.remote === undefined) {
        expect(capability.json.local).toBe(true);
        expect(capability.json.windows).toEqual(["desktop-authorization"]);
        continue;
      }
      expect(capability.file).toBe("local-desktop-controls-dev.json");
      expect(capability.json.local).toBe(false);
      expect(capability.json.windows).toEqual(["desktop-authorization", "linux-settings"]);
      const urls = (capability.json.remote as { urls: string[] }).urls;
      const patterns = urls.map((url) => new URLPattern(url));
      for (const url of urls) expect(patterns.some((pattern) => pattern.test(url))).toBe(true);
      for (const url of ["https://example.com/authorization.html", "http://localhost:7860/authorization.html",
        "http://localhost:1430/", "http://localhost:1430/untrusted.html"]) {
        expect(patterns.some((pattern) => pattern.test(url))).toBe(false);
      }
    }
    // The development capability serves both controls; the native check
    // keeps the graphics window from reading the ephemeral authorization URL.
    const source = readSource("remote_instance.rs");
    const status = source.slice(source.indexOf("pub fn remote_authorization_status"), source.indexOf("pub fn remote_authorization_cancel"));
    expect(status).toContain('window.label() != "desktop-authorization"');
  });

  test("signed release updates are available only to the bundled or development tray host", () => {
    const grants = capabilities().filter((capability) =>
      (capability.json.permissions as string[]).includes("desktop-release-updates"));
    expect(grants.length).toBe(2);
    for (const capability of grants) {
      expect(capability.json.windows).toEqual(["main"]);
      if (capability.json.remote !== undefined) {
        expect((capability.json.remote as { urls: string[] }).urls).toEqual([
          "http://127.0.0.1:1430", "http://localhost:1430",
        ]);
      } else expect(capability.json.local).toBe(true);
    }
    const build = readFileSync(join(HERE, "build.rs"), "utf8");
    for (const name of ["desktop_update_info", "desktop_update_check", "desktop_update_download", "desktop_update_install"]) expect(build).toContain(`"${name}"`);
  });
  test("local data folder access is limited to the bundled or development tray host", () => {
    const grants = capabilities().filter((capability) =>
      (capability.json.permissions as string[]).includes("local-data-folder"));
    expect(grants.length).toBe(2);
    for (const capability of grants) {
      expect(capability.json.windows).toEqual(["main"]);
      if (capability.json.remote !== undefined) {
        expect((capability.json.remote as { urls: string[] }).urls).toEqual([
          "http://127.0.0.1:1430", "http://localhost:1430",
        ]);
      } else expect(capability.json.local).toBe(true);
    }
    expect(readFileSync(join(HERE, "build.rs"), "utf8")).toContain('"open_lumiverse_data_folder"');
  });
  test("checkout selection is available only to the local instance selector", () => {
    const grants = capabilities().filter((capability) =>
      (capability.json.permissions as string[]).includes("instance-connection-setup"));
    expect(grants.length).toBe(2);
    for (const capability of grants) {
      expect(capability.json.windows).toEqual(["frontend-url-settings"]);
      if (capability.json.remote !== undefined) {
        expect((capability.json.remote as { urls: string[] }).urls).toEqual([
          "http://localhost:1430/custom-url.html", "http://127.0.0.1:1430/custom-url.html",
        ]);
      } else expect(capability.json.local).toBe(true);
    }
  });
  test("bundled setup callbacks are limited to their own local webview", () => {
    const grants = capabilities().filter((capability) =>
      (capability.json.permissions as string[]).includes("bundled-server-setup"));
    expect(grants.length).toBe(2);
    for (const capability of grants) {
      expect(capability.json.windows).toEqual(["server-setup"]);
      if (capability.json.remote !== undefined) {
        expect((capability.json.remote as { urls: string[] }).urls).toEqual([
          "http://localhost:1430/server-setup.html", "http://127.0.0.1:1430/server-setup.html",
        ]);
      } else expect(capability.json.local).toBe(true);
    }
  });
  test("network access settings belong only to the local tray host", () => {
    const grants = capabilities().filter((capability) =>
      (capability.json.permissions as string[]).includes("bundled-server-controls"));
    expect(grants.length).toBe(2);
    for (const capability of grants) {
      expect(capability.json.windows).toEqual(["main"]);
      if (capability.json.remote !== undefined) {
        expect((capability.json.remote as { urls: string[] }).urls).toEqual([
          "http://127.0.0.1:1430", "http://localhost:1430",
        ]);
      } else expect(capability.json.local).toBe(true);
    }
    const source = readSource("bundled_server.rs");
    const build = readFileSync(join(HERE, "build.rs"), "utf8");
    for (const command of ["bundled_server_network_access", "bundled_server_set_network_access"]) {
      expect(build).toContain(`"${command}"`);
      const body = source.slice(source.indexOf(`pub async fn ${command}`)).split("#[tauri::command]")[0];
      expect(body).toContain('require_window(&window, "main")?');
    }
  });
  /**
   * Labels of windows the Rust side builds from a bundled page. A capability
   * covering one of these must apply to local origins, or it matches the
   * window's label and grants it nothing.
   */
  function localWindowLabels(): string[] {
    const frontend = readSource("frontend.rs");
    const labels: string[] = [];
    for (const m of frontend.matchAll(
      /WebviewWindowBuilder::new\(\s*&app,\s*([^,]+?),\s*WebviewUrl::App/g,
    )) {
      const constName = m[1].trim().replace(/^&/, "");
      // Resolve `const FOO: &str = "bar";` to its literal.
      const decl = frontend.match(
        new RegExp(`const\\s+${constName}\\s*:\\s*&str\\s*=\\s*"([^"]+)"`),
      );
      if (decl) labels.push(decl[1]);
    }
    return labels;
  }

  function matchesWindow(pattern: string, label: string): boolean {
    if (pattern === label) return true;
    if (!pattern.includes("*")) return false;
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(label);
  }

  test("a local window is never left to a remote-only capability", () => {
    const labels = localWindowLabels();
    expect(labels.length).toBeGreaterThan(0);

    const broken: string[] = [];
    for (const label of labels) {
      const matching = capabilities().filter((c) =>
        ((c.json.windows as string[]) ?? []).some((w) => matchesWindow(w, label)),
      );
      if (matching.length === 0) continue;
      // `local` defaults to true when the key is absent.
      const reachable = matching.some((c) => c.json.local !== false);
      if (!reachable) {
        broken.push(`${label} → only ${matching.map((c) => c.file).join(", ")} (all local:false)`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("remote instance credentials are callable only from the bundled or development tray host", () => {
    const grants = capabilities().filter((capability) =>
      ((capability.json.permissions as Array<string | { identifier?: string }>) ?? [])
        .some((permission) => permission === "remote-instance-commands"
          || (typeof permission === "object" && permission.identifier === "remote-instance-commands")),
    );
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.some((capability) => capability.json.remote === undefined)).toBe(true);
    for (const capability of grants) {
      expect(capability.json.windows).toEqual(["main"]);
      if (capability.json.remote === undefined) {
        expect(capability.json.local).not.toBe(false);
        continue;
      }
      // Tauri serves the hidden tray from Vite in development. Keep that
      // exception on its fixed port; other loopback servers are remote content.
      expect(capability.file).toBe("tray-dev.json");
      expect(capability.json.local).toBe(false);
      const urls = (capability.json.remote as { urls: string[] }).urls;
      expect(urls.toSorted()).toEqual(["http://127.0.0.1:1430", "http://localhost:1430"]);
      const patterns = urls.map((url) => new URLPattern(url));
      const allows = (url: string) => patterns.some((pattern) => pattern.test(url));
      const config = JSON.parse(readFileSync(join(HERE, "tauri.conf.json"), "utf8"));
      expect(allows(config.build.devUrl)).toBe(true);
      for (const url of [
        "http://127.0.0.1:1430/", "http://localhost:1430/index.html",
      ]) expect(allows(url)).toBe(true);
      for (const url of [
        "http://localhost:7860/", "http://127.0.0.1:7860/",
        "http://localhost:1431/", "http://127.0.0.1:1431/",
        "https://localhost:1430/", "https://lumiverse.example/",
        "http://192.168.1.20:1430/",
      ]) expect(allows(url)).toBe(false);
    }
  });

  test("desktop installer handoff is callable only from the hidden local tray host", () => {
    const grants = capabilities().filter((capability) =>
      ((capability.json.permissions as Array<string | { identifier?: string }>) ?? [])
        .some((permission) => permission === "desktop-update-install"
          || (typeof permission === "object" && permission.identifier === "desktop-update-install")),
    );
    expect(grants.length).toBe(1);
    expect(grants[0].json.remote).toBeUndefined();
    expect(grants[0].json.local).not.toBe(false);
    expect(grants[0].json.windows).toEqual(["main"]);
  });

  test("capture control permissions never reach remote or extension windows", () => {
    const grants = capabilities().filter((capability) =>
      ((capability.json.permissions as string[]) ?? []).some((permission) =>
        typeof permission === "string" && (permission === "desktop-capture-controls"
          || permission.startsWith("allow-desktop-capture-"))),
    );
    expect(grants.length).toBe(1);
    expect(grants[0].json.remote).toBeUndefined();
    expect(grants[0].json.local).toBe(true);
    expect(grants[0].json.windows).toEqual(["main"]);
    const source = readSource("capture/mod.rs");
    expect(source).toContain('window.label() != "main"');
    expect(source).toContain("trusted_url(&url)");
    expect(source).not.toContain("pub bytes:");
  });
});

describe("system audio boundary", () => {
  const grantsOf = (permission: string) =>
    capabilities().filter((capability) =>
      ((capability.json.permissions as Array<string | { identifier?: string }>) ?? []).some(
        (entry) => entry === permission || (typeof entry === "object" && entry.identifier === permission),
      ),
    );

  test("the on/off switch is callable only from the bundled or development tray host", () => {
    const grants = grantsOf("desktop-system-audio-controls");
    expect(grants.map((grant) => grant.file).toSorted()).toEqual(["system-audio.json", "tray-dev.json"]);
    for (const grant of grants) {
      expect(grant.json.windows).toEqual(["main"]);
      if (grant.file === "tray-dev.json") {
        expect(grant.json.local).toBe(false);
        expect((grant.json.remote as { urls: string[] }).urls.toSorted()).toEqual([
          "http://127.0.0.1:1430",
          "http://localhost:1430",
        ]);
      } else {
        expect(grant.json.remote).toBeUndefined();
        expect(grant.json.local).not.toBe(false);
      }
    }
    expect(readSource("system_audio/mod.rs")).toContain("crate::capture::trusted_host(&window)");
  });

  test("a session can be started only by the primary frontend window", () => {
    const grants = grantsOf("desktop-system-audio-session");
    expect(grants.map((grant) => grant.file)).toEqual(["frontend-titlebar.json"]);
    expect(grants[0].json.windows).toEqual(["frontend"]);
    const source = readSource("system_audio/mod.rs");
    expect(source).toContain("window.label() == FRONTEND");
    // Floating widgets host extension pages: they must never receive this grant.
    for (const capability of capabilities()) {
      if (((capability.json.windows as string[]) ?? []).some((window) => window.startsWith("widget"))) {
        expect(JSON.stringify(capability.json.permissions)).not.toContain("system-audio");
      }
    }
  });

  test("only analysis frames can leave the capture thread", () => {
    const analyzer = readSource("system_audio/analyzer.rs");
    const source = readSource("system_audio/mod.rs").split("#[cfg(test)]")[0];
    // The wire message is a fixed-size header plus one value per band, nothing else.
    expect(analyzer).toContain("pub const MESSAGE_FLOATS: usize = 3 + BANDS;");
    expect(analyzer).toContain("pub fn encode(&self, kind: f32)");
    // Every message sent to the page is an encoded Frame, including loss of a pending session.
    const sends = source.split("InvokeResponseBody::Raw(").slice(1);
    expect(sends.length).toBe(2);
    for (const rest of sends) expect(rest.slice(0, 48)).toContain(".encode(");
    expect(source).not.toContain("emit_to(label, STATE_EVENT, frame");
  });
});

describe("native capture boundary", () => {
  test("macOS explicitly links the configured compiler's availability runtime", () => {
    const build = readFileSync(join(HERE, "build.rs"), "utf8");
    expect(build).toContain(".get_compiler()");
    expect(build).toContain(".to_command()");
    expect(build).toContain('.arg("--print-file-name=libclang_rt.osx.a")');
    expect(build).toContain("runtime_path.is_file()");
    expect(build).toContain('cargo:rustc-link-search=native={}');
    expect(build).toContain('cargo:rustc-link-lib=static=clang_rt.osx');
  });

  test("macOS development builds retain the configured application identity", () => {
    const config = JSON.parse(readFileSync(join(HERE, "tauri.conf.json"), "utf8"));
    const plist = readFileSync(join(HERE, "Info.plist"), "utf8");
    expect(plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1]).toBe(config.identifier);
    expect(plist.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/)?.[1]).toBe(config.productName);
    expect(plist.match(/<key>NSMicrophoneUsageDescription<\/key>\s*<string>([^<]+)<\/string>/)?.[1]).toBeTruthy();
    const entitlements = readFileSync(join(HERE, config.bundle.macOS.entitlements), "utf8");
    expect(entitlements).toMatch(/<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\s*\/>/);
  });

  test("bundled debug macOS apps override the production plist identity", () => {
    const config = JSON.parse(readFileSync(join(HERE, "tauri.conf.json"), "utf8"));
    const debug = JSON.parse(readFileSync(join(HERE, "tauri.debug-profile.conf.json"), "utf8"));
    const plist = readFileSync(join(HERE, debug.bundle.macOS.infoPlist), "utf8");
    expect(debug.identifier).not.toBe(config.identifier);
    expect(plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1]).toBe(debug.identifier);
    expect(plist.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/)?.[1]).toBe(debug.productName);
    expect(plist).toContain("NSMicrophoneUsageDescription");
    expect(plist).toContain("NSAudioCaptureUsageDescription");
  });

  test("macOS source selection opens directly without a capture window or Send step", () => {
    const native = readSource("capture/macos.m");
    expect(native).toContain('initWithTitle:self.requestedDisplay.length ? @"Approve the selected display for Lumiverse" : @"Choose a source for Lumiverse"');
    expect(native).toContain('[sources popUpMenuPositioningItem:nil atLocation:NSEvent.mouseLocation inView:nil]');
    expect(native).toContain('action:@selector(selectSource:)');
    expect(native).toContain("item.representedObject = display;");
    expect(native).toContain("item.representedObject = window;");
    expect(native).toContain("SCContentSharingPickerModeSingleDisplay | SCContentSharingPickerModeSingleWindow;");
    expect(native).toContain("[picker presentPickerUsingContentStyle:self.requestedStyle];");
    for (const removed of ["NSPanel", "NSWindow", "Capture & Send", "createPanel", "showReview", "Share This Capture", "Review Before Sending"]) expect(native).not.toContain(removed);
  });

  test("macOS requests missing OS permission directly and reuses existing permission", () => {
    const native = readSource("capture/macos.m");
    const action = native.match(/- \(void\)screenRecordingAccess:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    expect(action).toContain("if (!CGPreflightScreenCaptureAccess()) {");
    expect(action).toContain("CGRequestScreenCaptureAccess()");
    expect(native.match(/CGRequestScreenCaptureAccess\(\)/g)?.length).toBe(1);
    expect(action).toContain("getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES");
    expect(native.match(/getShareableContent/g)?.length).toBe(2);
    expect(action).toContain("systemUptime >= self.expiresAt");
    expect(native).not.toContain("localizedDescription");
    expect(readSource("capture/platform.rs")).not.toContain("CGRequestScreenCaptureAccess");
  });

  test("macOS source selection cannot auto-select or silently change its capture source", () => {
    const native = readSource("capture/macos.m");
    const selection = native.match(/- \(void\)selectSource:\(NSMenuItem \*\)sender \{[\s\S]*?\n\}/)?.[0];
    const capture = native.match(/- \(void\)captureFilter:\(SCContentFilter \*\)filter \{[\s\S]*?\n\}/)?.[0];
    expect(selection).toContain("if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }");
    expect(selection).toContain("sender.representedObject");
    expect(selection).toContain("[self filterForDisplay:source content:self.permissionedContent]");
    expect(selection).toContain("initWithDesktopIndependentWindow:window");
    expect(native).toContain("window.owningApplication.processID == getpid()");
    expect(native).toContain("excludingApplications:excluded exceptingWindows:@[]");
    expect(native).toContain("if (!self->_sourceChosen && !atomic_load(&self->_completed)) [self finishOutcome:2];");
    expect(capture).toContain("filter.style != self.requestedStyle");
    expect(capture).toContain("_usingPermissionedSources && !CGPreflightScreenCaptureAccess()");
    expect(native).toContain("self.permissionedContent = nil;");
    expect(native).toContain("sources.numberOfItems >= 258");
  });

  test("macOS TCC denial is reported as denied rather than a generic capture failure", () => {
    const native = readSource("capture/macos.m");
    expect(native).toContain("error.code == SCStreamErrorUserDeclined");
    expect(native).toContain("[self finishOutcome:denied ? 1 : 4];");
    expect(native).toContain("error.code == SCStreamErrorUserStopped");
    expect(native.match(/\[self captureFailed:error\]/g)?.length).toBeGreaterThanOrEqual(4);
  });

  test("only metadata controls cross IPC; pixels never pass through the frontend", () => {
    expect(registeredCommands().filter((name) => name.startsWith("desktop_capture_"))).toEqual([
      "desktop_capture_connect", "desktop_capture_disconnect", "desktop_capture_status",
      "desktop_capture_request_setup", "desktop_capture_setup_finished", "desktop_capture_reset_approvals",
    ]);
    const source = readSource("capture/mod.rs");
    expect(source).toContain('redirect(reqwest::redirect::Policy::none())');
    expect(source).toContain('header("X-Lumiverse-Capture-Lease"');
    expect(source).not.toContain("emit(");
    expect(source).not.toContain("eval(");
    expect(source).toContain("request.validate(capabilities, now_ms())");
  });

  test("macOS requires real hardware compression independently of GPU capture", () => {
    const native = readSource("capture/macos.m");
    expect(native.match(/kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder/g)?.length).toBe(2);
    expect(native).toContain("kVTCompressionPropertyKey_UsingHardwareAcceleratedVideoEncoder");
    expect(native).toContain("AVVideoEncoderSpecificationKey");
    expect(native).toContain("configuration.queueDepth = 3;");
    expect(native).toContain("configuration.capturesAudio = NO;");
    expect(native).toContain("configuration.captureMicrophone = NO;");
    expect(native).toContain("loadTracksWithMediaType:AVMediaTypeAudio");
    expect(native).toContain("tracks.count != 0");
  });

  test("native cancellation, expiry, lock, and cleanup stay independent of extension UI", () => {
    const native = readSource("capture/macos.m");
    expect(native).toContain("SCContentSharingPicker.sharedPicker");
    expect(native).toContain("configuration.allowsChangingSelectedContent = NO;");
    expect(native).toContain('@"Cancel This Capture"');
    expect(native).toContain('@"com.apple.screenIsLocked"');
    expect(native).toContain("now >= self.expiresAt");
    expect(native).toContain("size.unsignedLongLongValue > self.maximumBytes");
    expect(native).toContain("mkdtemp(path)");
    expect(native).toContain("removeItemAtURL:self.directory");
    expect(native).toContain("[self.sourceMenu cancelTracking];");
  });

  test("macOS restores approved sources and records without a foreground popup", () => {
    const native = readSource("capture/macos.m");
    const start = native.match(/- \(void\)start \{[\s\S]*?\n\}/)?.[0];
    expect(start).toContain("NSStatusBar.systemStatusBar statusItemWithLength:");
    expect(start).toContain("[self restoreSource];");
    expect(start).toContain("[self showSetup];");
    expect(native).not.toContain("orderFront");
    expect(native).not.toContain("activateIgnoringOtherApps");
    expect(native).not.toContain("makeKeyAndOrderFront");
    expect(native).toContain("[self share:nil];");
    expect(native).toContain("capture.rememberSource = remember;");
  });

  test("source selection persists independently of cancellation and only explicit disable revokes approval", () => {
    const cocoa = readSource("capture/macos.m");
    expect(cocoa).toContain("identity.toolTip = self.consent;");
    expect(cocoa).toContain('initWithTitle:@"Cancel This Capture" action:@selector(discard:)');
    expect(cocoa).toContain("self.rememberSource(self.context, self.selectedSource.UTF8String)");
    expect(cocoa).toContain("- (void)discard:(id)sender { [self finishOutcome:2]; }");
    expect(cocoa).toContain("self.captureIndicator.menu = nil;");
    expect(cocoa).toContain("removeStatusItem:self.captureIndicator");
    for (const file of ["capture/platform.rs", "capture/windows.rs"]) {
      const native = readSource(file);
      expect(native).not.toContain(".pause()");
      expect(native).not.toContain(".disable(");
      expect(native).not.toContain("desktop-capture-disabled");
    }
    const windows = readSource("capture/windows.rs");
    const selected = windows.match(/    fn selected\(&mut self, item: GraphicsCaptureItem\) -> Result<\(\)> \{[\s\S]*?\n    \}/)?.[0];
    const finish = windows.match(/    fn finish\(&mut self, result:[\s\S]*?\n    \}/)?.[0];
    expect(selected).toContain("self.approval.remember(source.clone());");
    expect(finish).not.toContain("self.approval");
    expect(finish).not.toContain("sources.remove");
  });

  test("persistent approval cannot be requested through worker-controlled capture flags", () => {
    const native = readSource("capture/mod.rs");
    const request = native.match(/struct CaptureRequest \{[\s\S]*?\n\}/)?.[0];
    expect(request).not.toContain("automatic_share");
    expect(request).not.toContain("remember");
    expect(native).not.toContain("ConsentState");
    expect(native).not.toContain("runtime_id:");
    expect(native).toContain("approval_revision: Option<String>");
    expect(native).toContain("Selecting a source authorizes capture and release");
    const macos = readSource("capture/platform.rs");
    expect(macos).toContain("completion.active.load(Ordering::SeqCst)");
    const cocoa = readSource("capture/macos.m");
    const share = cocoa.match(/- \(void\)share:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    expect(share).toContain("atomic_load(&_completed) || !_sourceChosen");
    expect(share).toContain("systemUptime >= self.expiresAt");
    expect(share).toContain("_usingPermissionedSources && !CGPreflightScreenCaptureAccess()");
    const windows = readSource("capture/windows.rs");
    expect(windows).toContain("self.phase != Phase::Preview");
    expect(windows).toContain("!self.control.active.load(Ordering::SeqCst)");
  });

  test("capture exposes one persistent tray toggle and no separate Remember control", () => {
    const tray = readFileSync(join(HERE, "../src/main.ts"), "utf8").replace(/\r\n/g, "\n");
    const browser = tray.match(/frontendItem = await Submenu\.new\(\{[\s\S]*?\n  \}\);/)?.[0];
    const root = tray.match(/const menu = await Menu\.new\(\{[\s\S]*?\n  \}\);/)?.[0];
    expect(browser).not.toContain("desktopCaptureItem");
    expect(root).toContain("systemAudioItem,\n      desktopCaptureItem,");
    expect(tray).not.toContain("Allow Screen Capture Requests Again");
    expect(tray).not.toContain("Forget Screen Capture Approvals");
    expect(readSource("capture/macos.m")).not.toContain("checkboxWithTitle");
    expect(readSource("capture/windows.rs")).not.toContain("BS_AUTOCHECKBOX");
  });

  test("Windows uses an invisible owner and opens only the system source picker when needed", () => {
    const native = readSource("capture/windows.rs");
    expect(native).toContain("state.choose()?;");
    expect(native).toContain("self.share()");
    expect(native).not.toContain("ShowWindow(");
    expect(native).not.toContain("SetForegroundWindow");
    expect(native).not.toContain("CreateWindowExW(\n                WS_EX_TOPMOST");
    expect(native).not.toContain("Capture & Send");
    expect(native).not.toContain("Stop & Discard");
    expect(native).not.toContain("Review Before Sending");
  });

  test("Windows uses the system picker and GPU surfaces without frontend or filesystem capture", () => {
    const native = readSource("capture/windows.rs");
    const platform = readSource("capture/platform.rs");
    expect(platform).toContain("super::windows::begin(");
    expect(native).toContain('"Windows.Foundation.UniversalApiContract"');
    expect(native).toContain("GraphicsCaptureSession::IsSupported()");
    expect(native).toContain("GraphicsCapturePicker::new()");
    expect(native).toContain("initializer.Initialize(self.window)");
    expect(native).toContain("PickSingleItemAsync()");
    expect(native).toContain("D3D_DRIVER_TYPE_HARDWARE");
    expect(native).toContain("Direct3D11CaptureFramePool::CreateFreeThreaded(");
    expect(native).toContain("InMemoryRandomAccessStream::new()");
    expect(native).not.toContain("CreateForWindow");
    expect(native).not.toContain("CreateForMonitor");
    expect(native).not.toContain("std::fs");
    expect(native).not.toContain("BitBlt(");
    expect(native).not.toContain("emit(");
    expect(native).not.toContain("eval(");
  });

  test("Windows accepts the selected system item without restricting selection to windows or displays", () => {
    const native = readSource("capture/windows.rs");
    const choose = native.match(/    fn choose\(&mut self\) -> Result<\(\)> \{[\s\S]*?\n    \}/)?.[0];
    const selected = native.match(/    fn selected\(&mut self, item: GraphicsCaptureItem\) -> Result<\(\)> \{[\s\S]*?\n    \}/)?.[0];
    expect(choose).toContain("GraphicsCapturePicker::new()");
    expect(choose).toContain("initializer.Initialize(self.window)");
    expect(choose).toContain("picker.PickSingleItemAsync()");
    expect(selected).toContain("pool.CreateCaptureSession(&item)");
    expect(native).not.toContain("CreateForWindow");
    expect(native).not.toContain("CreateForMonitor");
    expect(native).not.toContain("GetForegroundWindow");
  });

  test("Windows hardware preference, no-audio policy and native preview are explicit", () => {
    const native = readSource("capture/windows.rs");
    expect(native).toContain("SetHardwareAccelerationEnabled(true)");
    expect(readSource("capture/mod.rs")).toContain("Windows may fall back to software H.264.");
    expect(native).toContain("profile.SetAudio(None::<&AudioEncodingProperties>)");
    expect(native).toContain("output.SetBitrate(8_000_000)");
    expect(native).toContain("MediaStreamSample::CreateFromDirect3D11Surface");
    expect(native).toContain("playback.AudioTracks()?.Size()? != 0");
    expect(native).toContain("session.NaturalVideoWidth()? != self.width");
    expect(native).toContain("VideoFrameAvailable(");
    expect(native).toContain("CopyFrameToVideoSurface(");
    expect(native).toContain("self.pixels.is_none()");
  });

  test("Windows cancellation, backpressure and deferral cleanup fail closed", () => {
    const native = readSource("capture/windows.rs");
    expect(native).toContain("WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)?");
    for (const notification of ["WTS_SESSION_LOCK", "WTS_SESSION_LOGOFF", "WTS_CONSOLE_DISCONNECT", "WTS_REMOTE_DISCONNECT", "PBT_APMSUSPEND"]) {
      expect(native).toContain(notification);
    }
    expect(native).toContain("self.request.expires_at <= super::now_ms()");
    expect(native).toContain("self.request.expires_at > super::now_ms()");
    expect(native).toContain("self.start = Some(Instant::now())");
    expect(native).not.toContain("self.start.get_or_insert_with");
    expect(native).toContain("stream.Size()? > self.request.max_bytes as u64");
    expect(native).toContain("size.Width != self.source_width as i32");
    expect(native).toContain("mpsc::sync_channel(8)");
    expect(native).toContain("try_send(event)");
    expect(native).toContain("impl Drop for SampleRequest");
    expect(native).toContain("self.deferral.Complete()");
    expect(native).toContain("if cancelled");
    expect(native).toContain("try_borrow_mut()");
    expect(native).toContain("self.control.alive.store(false, Ordering::SeqCst)");
    expect(native).toContain("player.Close()");
    expect(native).toContain("stream.Close()");
  });
});
