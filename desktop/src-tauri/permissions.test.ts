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
  return readFileSync(join(HERE, "src", name), "utf8");
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

  test("macOS explicitly offers other-app windows and entire displays through the system picker", () => {
    const native = readSource("capture/macos.m");
    expect(native).toContain('addItemWithTitle:@"Entire Display"');
    expect(native).toContain('addItemWithTitle:@"Window"');
    expect(native).toContain("self.sourcePicker.lastItem.tag = SCShareableContentStyleDisplay;");
    expect(native).toContain("self.sourcePicker.lastItem.tag = SCShareableContentStyleWindow;");
    expect(native).toContain("contentStyle != SCShareableContentStyleWindow && contentStyle != SCShareableContentStyleDisplay");
    expect(native).toContain("SCContentSharingPickerModeSingleDisplay | SCContentSharingPickerModeSingleWindow;");
    expect(native).toContain("[picker presentPickerUsingContentStyle:contentStyle];");
    expect(native).toContain("if (self.panel.windowNumber > 0) configuration.excludedWindowIDs = @[@(self.panel.windowNumber)];");
    expect(native).toContain("self.sourcePicker.enabled = NO;");
    expect(native).toContain("self.sourcePicker.hidden = YES;");
    expect(native).not.toContain("[picker present];");
    expect(native).toContain("filter.style != self.requestedStyle");
  });

  test("macOS app-wide permission requests and source enumeration require a native owner action", () => {
    const native = readSource("capture/macos.m");
    const action = native.match(/- \(void\)screenRecordingAccess:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    expect(action).toBeDefined();
    expect(action).toContain("CGRequestScreenCaptureAccess()");
    expect(native.match(/CGRequestScreenCaptureAccess\(\)/g)?.length).toBe(1);
    expect(action).toContain("if (!CGPreflightScreenCaptureAccess()) { [self refreshScreenRecordingAccess]; return; }");
    expect(action).toContain("getShareableContentExcludingDesktopWindows:YES onScreenWindowsOnly:YES");
    expect(native.match(/getShareableContent/g)?.length).toBe(1);
    expect(native).toContain("action:@selector(screenRecordingAccess:)");
    expect(native).toContain("Privacy_ScreenCapture");
    expect(action).toContain("systemUptime >= self.expiresAt");
    expect(native).not.toContain("localizedDescription");
    expect(readSource("capture/platform.rs")).not.toContain("CGRequestScreenCaptureAccess");
  });

  test("macOS permissioned fallback cannot auto-select or silently change its capture source", () => {
    const native = readSource("capture/macos.m");
    const selection = native.match(/- \(void\)chooseSource:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    const capture = native.match(/- \(void\)captureFilter:\(SCContentFilter \*\)filter \{[\s\S]*?\n\}/)?.[0];
    const share = native.match(/- \(void\)share:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    expect(selection).toContain("if (!CGPreflightScreenCaptureAccess()) { [self finishOutcome:1]; return; }");
    expect(selection).toContain("self.permissionedSources.selectedItem.representedObject");
    expect(selection).toContain("initWithDisplay:source excludingWindows:excluded");
    expect(selection).toContain("initWithDesktopIndependentWindow:source");
    expect(selection).toContain("window.owningApplication.processID == getpid()");
    expect(native).toContain('addItemWithTitle:@"Select a display or another app\'s window…"');
    expect(native).toContain("self.primary.enabled = self.permissionedSources.selectedItem.representedObject != nil;");
    expect(capture).toContain("filter.style != self.requestedStyle");
    expect(capture).toContain("_usingPermissionedSources && !CGPreflightScreenCaptureAccess()");
    expect(share).toContain("_usingPermissionedSources && !CGPreflightScreenCaptureAccess()");
    expect(native).toContain("self.permissionedContent = nil;");
    expect(native).toContain("[self.permissionedSources removeAllItems];");
    expect(native).toContain("self.sourcePicker.enabled = YES;");
    expect(native).toContain("self.permissionedSources.numberOfItems >= 257");
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

  test("native preview, expiry, lock, and cleanup stay independent of extension UI", () => {
    const native = readSource("capture/macos.m");
    expect(native).toContain("SCContentSharingPicker.sharedPicker");
    expect(native).toContain("configuration.allowsChangingSelectedContent = NO;");
    expect(native).toContain('@"Share This Capture"');
    expect(native).toContain('@"Stop & Discard"');
    expect(native).toContain('@"com.apple.screenIsLocked"');
    expect(native).toContain("now >= self.expiresAt");
    expect(native).toContain("size.unsignedLongLongValue > self.maximumBytes");
    expect(native).toContain("mkdtemp(path)");
    expect(native).toContain("removeItemAtURL:self.directory");
  });

  test("macOS opens only the system picker and records without a Lumiverse popup", () => {
    const native = readSource("capture/macos.m");
    const start = native.match(/- \(void\)start \{[\s\S]*?\n\}/)?.[0];
    const recording = native.match(/- \(void\)startRecordingWithFilter:[\s\S]*?\n\}/)?.[0];
    const review = native.match(/- \(void\)showReview \{[\s\S]*?\n\}/)?.[0];
    expect(start).not.toContain("NSPanel");
    expect(start).not.toContain("createPanel");
    expect(start).not.toContain("orderFront");
    expect(recording).not.toContain("createPanel");
    expect(recording).not.toContain("orderFront");
    expect(start).toContain("NSStatusBar.systemStatusBar statusItemWithLength:");
    expect(start).toContain("[self chooseSource:nil];");
    expect(native).toContain("NSWindowStyleMaskNonactivatingPanel");
    expect(native).not.toContain("activateIgnoringOtherApps");
    expect(native).not.toContain("makeKeyAndOrderFront");
    expect(native).toContain("self.detailsPopover.contentViewController = detailsController;");
    expect(native).toContain("if (self.automaticShare) { [self share:nil]; return; }");
    expect(review!.indexOf("if (self.automaticShare)")).toBeLessThan(review!.indexOf("[self createPanel]"));
    expect(native).toContain("capture.automaticShare = YES;");
    expect(native).toContain("self.automaticShare = NO;");
    expect(native).toContain('self.primary.title = @"Review Before Sending";');
  });

  test("macOS keeps native menu-bar identity, cancellation and optional recovery controls", () => {
    const native = readSource("capture/macos.m");
    expect(native).toContain("identity.toolTip = self.consent;");
    expect(native).toContain('initWithTitle:@"Stop & Discard" action:@selector(discard:)');
    expect(native).toContain('initWithTitle:@"Capture Details & Permissions…"');
    expect(native).toContain("self.windowAction.enabled = NO;");
    expect(native).toContain("self.displayAction.enabled = NO;");
    expect(native).toContain("self.sourcePicker ? self.sourcePicker.selectedTag : self.requestedStyle;");
    expect(native).toContain("self.captureIndicator.menu = nil;");
    expect(native).toContain("removeStatusItem:self.captureIndicator");
    expect(native).toContain("if (self.imageView) [self.panel.contentView addSubview:self.imageView];");
    expect(native).toContain("if (self.playerView) [self.panel.contentView addSubview:self.playerView];");
    const details = native.match(/- \(void\)openDetails:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    expect(details).toContain("[self createPanel];");
    expect(details).toContain("[self.panel orderFrontRegardless];");
  });

  test("one-shot release cannot bypass native source selection or change the wire protocol", () => {
    const native = readSource("capture/mod.rs");
    const request = native.match(/struct CaptureRequest \{[\s\S]*?\n\}/)?.[0];
    expect(request).not.toContain("automatic_share");
    expect(request).not.toContain("remember");
    expect(native).not.toContain("ConsentState");
    expect(native).not.toContain("runtime_id:");
    expect(native).not.toContain("revision:");
    expect(native).toContain("Selecting a source authorizes this one capture");
    const macos = readSource("capture/platform.rs");
    expect(macos).toContain("completion.active.load(Ordering::SeqCst)");
    const cocoa = readSource("capture/macos.m");
    const share = cocoa.match(/- \(void\)share:\(id\)sender \{[\s\S]*?\n\}/)?.[0];
    expect(share).toContain("atomic_load(&_completed) || !_sourceChosen");
    expect(share).toContain("systemUptime >= self.expiresAt");
    expect(share).toContain("_usingPermissionedSources && !CGPreflightScreenCaptureAccess()");
    const windows = readSource("capture/windows.rs");
    expect(windows).toContain("automatic_share: true,");
    expect(windows).toContain("self.phase != Phase::Preview");
    expect(windows).toContain("!self.control.active.load(Ordering::SeqCst)");
  });

  test("Windows opens its picker immediately without a foreground consent window", () => {
    const native = readSource("capture/windows.rs");
    expect(native).toContain("ShowWindow(window, SW_SHOWNOACTIVATE)");
    expect(native).toContain("state.choose()?;");
    expect(native).not.toContain("SetForegroundWindow");
    expect(native).toContain("if self.automatic_share {");
    expect(native).toContain("return self.share();");
    expect(native).not.toContain("BS_AUTOCHECKBOX");
    expect(native).toContain("DETAILS_BUTTON =>");
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
    expect(native).toContain("output.SetBitrate(4_000_000)");
    expect(native).toContain("MediaStreamSample::CreateFromDirect3D11Surface");
    expect(native).toContain("playback.AudioTracks()?.Size()? != 0");
    expect(native).toContain("session.NaturalVideoWidth()? != self.width");
    expect(native).toContain("VideoFrameAvailable(");
    expect(native).toContain("CopyFrameToVideoSurface(");
    expect(native).toContain("self.pixels.is_none()");
    expect(native).toContain('w!("Share This Capture")');
    expect(native).toContain('"Stop & Discard"');
    expect(native).toContain('"Replay Clip"');
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
