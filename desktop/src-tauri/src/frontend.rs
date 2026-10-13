//! Frontend window — a native WebView loading the local Lumiverse server.

use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{
    webview::DownloadEvent, AppHandle, Emitter, LogicalSize, Manager, State, Webview, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

/// Emit a native marker after the hidden webview has created its tray icon.
/// Besides being useful in terminal diagnostics, CI uses this to distinguish
/// a working tray from a startup-error dialog that merely remains open.
#[tauri::command]
pub fn desktop_startup_ready() {
    eprintln!("[desktop-startup] tray ready");
}

#[cfg(target_os = "macos")]
fn high_refresh_webview_configuration(
) -> Option<objc2::rc::Retained<objc2_web_kit::WKWebViewConfiguration>> {
    use objc2::{msg_send, runtime::AnyObject, sel, ClassType, MainThreadMarker};
    use objc2_foundation::{NSArray, NSString};
    use objc2_web_kit::WKWebViewConfiguration;

    const FPS_LIMIT_FEATURE: &str = "PreferPageRenderingUpdatesNear60FPSEnabled";

    let main_thread = MainThreadMarker::new()?;

    // WebKit still enables this preference by default on macOS. Its own
    // description says that it prefers page rendering updates near 60 fps
    // instead of using the display's refresh rate. Safari overrides WebKit
    // preferences internally, but an embedded WKWebView inherits the default.
    //
    // Apple does not expose this switch through public WKPreferences API. The
    // generic feature API below is declared in WKPreferencesPrivate.h. Keep the
    // lookup defensive so a future WebKit version that removes or renames the
    // feature falls back to the stock WKWebView configuration.
    unsafe {
        let configuration = WKWebViewConfiguration::new(main_thread);
        let preferences = configuration.preferences();
        let preferences_class = objc2_web_kit::WKPreferences::class();
        let has_feature_api: bool =
            msg_send![preferences_class, respondsToSelector: sel!(_features)];
        if !has_feature_api {
            return None;
        }
        let features: objc2::rc::Retained<NSArray<AnyObject>> =
            msg_send![preferences_class, _features];

        for index in 0..features.count() {
            let feature = features.objectAtIndex(index);
            let key: objc2::rc::Retained<NSString> = msg_send![&*feature, key];
            if key.to_string() == FPS_LIMIT_FEATURE {
                let _: () = msg_send![&*preferences, _setEnabled: false, forFeature: &*feature];
                return Some(configuration);
            }
        }
    }

    eprintln!(
        "WebKit feature {FPS_LIMIT_FEATURE} was unavailable; using the default frame-rate policy"
    );
    None
}

/// Transparent WKWebViews can still composite a square backing layer just
/// outside the document's CSS clip. Mask the native content layer as well,
/// keeping the AppKit frame aligned with Lumiverse's 12px web corner radius.
#[cfg(target_os = "macos")]
fn enforce_frontend_content_corner_radius(window: &WebviewWindow) -> Result<(), String> {
    use objc2::{msg_send, runtime::AnyObject};

    let window = window.clone();
    let appkit_window = window.clone();
    window
        .run_on_main_thread(move || unsafe {
            let Ok(ns_window) = appkit_window.ns_window() else {
                eprintln!("[desktop-window] could not access AppKit window for corner clipping");
                return;
            };
            let ns_window = &*ns_window.cast::<AnyObject>();
            let content_view: *mut AnyObject = msg_send![ns_window, contentView];
            if content_view.is_null() {
                return;
            }
            let content_view = &*content_view;
            let _: () = msg_send![content_view, setWantsLayer: true];
            let layer: *mut AnyObject = msg_send![content_view, layer];
            if layer.is_null() {
                return;
            }
            let layer = &*layer;
            let _: () = msg_send![layer, setCornerRadius: FRONTEND_CORNER_RADIUS as f64];
            let _: () = msg_send![layer, setMasksToBounds: true];
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

const FRONTEND_LABEL: &str = "frontend";
const FRONTEND_TITLE: &str = "Lumiverse";
const DEFAULT_WIDTH: u32 = 1200;
const DEFAULT_HEIGHT: u32 = 800;
const FRONTEND_TITLEBAR_HEIGHT: u32 = 36;
const FRONTEND_CORNER_RADIUS: u32 = 12;
const FRONTEND_WINDOWS_CORNER_RADIUS: u32 = 8;
const RESTORE_MARGIN: i32 = 24;
const FRONTEND_STARTUP_APPEARANCE_FILE: &str = "frontend_startup_appearance.json";
static NEXT_FRONTEND_POPUP_ID: AtomicU64 = AtomicU64::new(1);
const CHROMELESS_WIDGET_MIN_SIZE: u32 = 24;
const CHROMED_WIDGET_MIN_WIDTH: u32 = 160;
const CHROMED_WIDGET_MIN_HEIGHT: u32 = 100;
const WIDGET_MAX_WIDTH: u32 = 1200;
const WIDGET_MAX_HEIGHT: u32 = 900;

// WebView2 explicitly supports this switch for applications whose foreground
// work must not be coalesced into background-timer batches. Supplying browser
// arguments replaces Wry's defaults, so retain its UI/SmartScreen feature
// exclusions alongside the streaming fix. Every WebView in this process uses
// the same value because WebView2 requires matching environment options for a
// shared user-data directory.
#[cfg(target_os = "windows")]
const WINDOWS_WEBVIEW_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --disable-background-timer-throttling";

fn configure_webview_runtime<'a, R: tauri::Runtime, M: tauri::Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args(WINDOWS_WEBVIEW_BROWSER_ARGS);
    builder
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopDownloadEvent {
    phase: &'static str,
    id: String,
    file_name: String,
    success: Option<bool>,
}

fn download_file_name(url: &tauri::Url, path: Option<&std::path::Path>) -> String {
    path.and_then(|path| path.file_name())
        .and_then(|name| name.to_str())
        .or_else(|| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or("download")
        .to_string()
}

fn report_frontend_download(webview: Webview, event: DownloadEvent<'_>) -> bool {
    let payload = match event {
        DownloadEvent::Requested { url, destination } => DesktopDownloadEvent {
            phase: "started",
            id: url.to_string(),
            file_name: download_file_name(&url, Some(destination)),
            success: None,
        },
        DownloadEvent::Finished { url, path, success } => DesktopDownloadEvent {
            phase: "finished",
            id: url.to_string(),
            file_name: download_file_name(&url, path.as_deref()),
            success: Some(success),
        },
        _ => return true,
    };
    let _ = webview.emit("desktop-download", payload);
    true
}

fn is_frontend_popup_label(label: &str) -> bool {
    label.strip_prefix("frontend-popup-").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    })
}

/// Destroy the invoking SSO popup without granting remote content generic
/// access to other native windows. Browser `window.close()` is not a reliable
/// lifecycle signal for Rust-created WebviewWindows on every platform.
#[tauri::command]
pub fn close_current_sso_popup(window: WebviewWindow) -> Result<(), String> {
    if !is_frontend_popup_label(window.label()) {
        return Err("Only a Lumiverse sign-in popup may invoke this command".into());
    }
    window.destroy().map_err(|error| error.to_string())
}

#[derive(Default)]
pub struct FrontendState {
    /// Persisted window bounds: (x, y, width, height) or None for defaults.
    bounds: Mutex<Option<(i32, i32, u32, u32)>>,
}

/// Native window-presence snapshot consumed by the remote frontend. Browser
/// page visibility cannot distinguish a hidden-to-tray window from a window
/// that is merely covered by another app, so the desktop host owns these
/// signals and lets the frontend reduce them to its active/away status.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendPresence {
    state: &'static str,
    visible: bool,
    minimized: bool,
    focused: bool,
    active: bool,
}

fn frontend_presence_for_window<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> FrontendPresence {
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    let state = if !visible {
        "hidden"
    } else if minimized {
        "minimized"
    } else if focused {
        "foreground"
    } else {
        "background"
    };

    FrontendPresence {
        state,
        visible,
        minimized,
        focused,
        active: visible && !minimized && focused,
    }
}

pub fn emit_frontend_presence<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
) {
    let _ = app.emit_to(
        FRONTEND_LABEL,
        "desktop-presence-changed",
        frontend_presence_for_window(window),
    );
}

/// A small, local-only cache written by the trusted frontend after it has
/// resolved its theme. It lets a new remote WebView draw a familiar titlebar
/// and surface before the full page bundle has loaded.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendStartupAppearance {
    background: String,
    border: String,
    text_muted: String,
    primary: String,
    blur: bool,
    dark: bool,
    blur_intensity: String,
    native_color: [u8; 3],
    #[serde(default)]
    high_refresh: bool,
}

impl Default for FrontendStartupAppearance {
    fn default() -> Self {
        Self {
            background: "#0a0812".into(),
            border: "rgba(255, 255, 255, 0.08)".into(),
            text_muted: "rgba(255, 255, 255, 0.64)".into(),
            primary: "#9370db".into(),
            blur: false,
            dark: true,
            blur_intensity: "balanced".into(),
            native_color: [10, 8, 18],
            high_refresh: false,
        }
    }
}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWidgetDescriptor {
    id: String,
    extension_id: String,
    index: u8,
    title: String,
    width: u32,
    height: u32,
    chromeless: bool,
}

#[derive(Default)]
pub struct DesktopWidgetCatalogState {
    widgets: Mutex<Vec<DesktopWidgetDescriptor>>,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopWidgetPopoutState {
    id: String,
    popped_out: bool,
}

fn emit_widget_popout_state(
    app: &AppHandle,
    widget_id: String,
    popped_out: bool,
) -> Result<(), String> {
    let state = DesktopWidgetPopoutState {
        id: widget_id,
        popped_out,
    };
    app.emit_to("main", "desktop-widget-popout-state", state.clone())
        .map_err(|error| error.to_string())?;
    app.emit_to(FRONTEND_LABEL, "desktop-widget-popout-state", state)
        .map_err(|error| error.to_string())
}

fn extension_widget_label(widget: &DesktopWidgetDescriptor) -> String {
    // Tauri window labels deliberately permit only a small character set. Use
    // a deterministic FNV-1a hash so untrusted extension IDs never enter it.
    let hash = widget
        .id
        .bytes()
        .chain(widget.extension_id.bytes())
        .fold(0xcbf29ce484222325_u64, |value, byte| {
            (value ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    format!("widget-{hash:016x}")
}

fn valid_widget_descriptor(widget: &DesktopWidgetDescriptor) -> bool {
    !widget.id.is_empty()
        && widget.id.len() <= 256
        && !widget.extension_id.is_empty()
        && widget.extension_id.len() <= 200
        && !widget.title.is_empty()
        && widget.title.len() <= 120
        && widget.index <= 3
        && valid_widget_size(widget.chromeless, widget.width, widget.height)
}

fn valid_widget_size(chromeless: bool, width: u32, height: u32) -> bool {
    let (min_width, min_height) = if chromeless {
        (CHROMELESS_WIDGET_MIN_SIZE, CHROMELESS_WIDGET_MIN_SIZE)
    } else {
        (CHROMED_WIDGET_MIN_WIDTH, CHROMED_WIDGET_MIN_HEIGHT)
    };
    (min_width..=WIDGET_MAX_WIDTH).contains(&width)
        && (min_height..=WIDGET_MAX_HEIGHT).contains(&height)
}

fn bounds_file<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("frontend_bounds.json"))
}

fn frontend_startup_appearance_file<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(FRONTEND_STARTUP_APPEARANCE_FILE))
}

fn valid_startup_appearance(appearance: &FrontendStartupAppearance) -> bool {
    let valid_css_value = |value: &str| {
        !value.is_empty()
            && value.len() <= 160
            && !value.contains('\0')
            && !value.contains('<')
            && !value.contains('>')
    };
    valid_css_value(&appearance.background)
        && valid_css_value(&appearance.border)
        && valid_css_value(&appearance.text_muted)
        && valid_css_value(&appearance.primary)
        && matches!(
            appearance.blur_intensity.as_str(),
            "subtle" | "balanced" | "strong"
        )
}

fn load_frontend_startup_appearance<R: tauri::Runtime>(
    app: &AppHandle<R>,
) -> FrontendStartupAppearance {
    frontend_startup_appearance_file(app)
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|json| serde_json::from_str::<FrontendStartupAppearance>(&json).ok())
        .filter(valid_startup_appearance)
        .unwrap_or_default()
}

fn save_frontend_startup_appearance<R: tauri::Runtime>(
    app: &AppHandle<R>,
    appearance: &FrontendStartupAppearance,
) -> Result<(), String> {
    let file = frontend_startup_appearance_file(app)
        .ok_or("Unable to access the desktop configuration directory")?;
    let json = serde_json::to_string(appearance).map_err(|error| error.to_string())?;
    std::fs::write(file, json).map_err(|error| error.to_string())
}

fn frontend_startup_shell_script(
    appearance: &FrontendStartupAppearance,
    windows_corners: &str,
    frontend_origin: &str,
) -> String {
    let snapshot = serde_json::to_string(appearance).unwrap_or_else(|_| "{}".into());
    let frontend_origin = serde_json::to_string(frontend_origin).unwrap();
    let titlebar_height = FRONTEND_TITLEBAR_HEIGHT;
    let corner_radius = match windows_corners {
        "rounded" => FRONTEND_WINDOWS_CORNER_RADIUS,
        "square" => 0,
        _ => FRONTEND_CORNER_RADIUS,
    };
    format!(
        r#"(() => {{
  // WKWebView popup configurations inherit the opener's user scripts. Keep
  // the app's custom chrome out of native popups and external provider pages.
  const windowLabel = window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label;
  if (window.opener || (windowLabel && windowLabel !== 'frontend') ||
      (!windowLabel && window.location.origin !== {frontend_origin})) return;
  const snapshot = {snapshot};
  const root = document.documentElement;
  const set = (name, value) => {{ if (typeof value === 'string') root.style.setProperty(name, value); }};
  set('--lumiverse-startup-background', snapshot.background);
  set('--lumiverse-startup-border', snapshot.border);
  set('--lumiverse-startup-text-muted', snapshot.textMuted);
  set('--lumiverse-startup-primary', snapshot.primary);
  root.setAttribute('data-tauri-desktop', '');
  if ('{windows_corners}') root.setAttribute('data-desktop-windows-corners', '{windows_corners}');
  root.setAttribute('data-lumiverse-startup-shell', '');

  const mount = () => {{
    if (document.getElementById('lumiverse-startup-shell')) return;
    const shell = document.createElement('div');
    shell.id = 'lumiverse-startup-shell';
    shell.setAttribute('aria-hidden', 'true');
    shell.innerHTML = '<div class="lumiverse-startup-titlebar"><div class="lumiverse-startup-drag" data-tauri-drag-region="deep"><span class="lumiverse-startup-dot"></span><span>Lumiverse</span></div><span class="lumiverse-startup-controls"><i></i><i></i><i></i></span></div><div class="lumiverse-startup-pulse"></div>';
    const style = document.createElement('style');
    style.textContent = '#lumiverse-startup-shell{{position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:var(--lumiverse-startup-background,#0a0812);color:var(--lumiverse-startup-text-muted,rgba(255,255,255,.64));font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em}}.lumiverse-startup-titlebar{{position:relative;height:{titlebar_height}px;box-sizing:border-box;border-radius:{corner_radius}px {corner_radius}px 0 0;overflow:hidden;border-bottom:1px solid var(--lumiverse-startup-border,rgba(255,255,255,.08));background:color-mix(in srgb,var(--lumiverse-startup-background,#0a0812) 86%,transparent)}}.lumiverse-startup-drag{{position:absolute;inset:1px 1px 0;display:flex;align-items:center;justify-content:center;gap:8px;pointer-events:auto;cursor:grab;user-select:none;-webkit-user-select:none}}.lumiverse-startup-dot{{width:8px;height:8px;border-radius:999px;background:var(--lumiverse-startup-primary,#9370db);box-shadow:0 0 0 3px color-mix(in srgb,var(--lumiverse-startup-primary,#9370db) 12%,transparent)}}.lumiverse-startup-controls{{position:absolute;top:50%;right:12px;display:flex;gap:7px;transform:translateY(-50%)}}.lumiverse-startup-controls i{{display:block;width:11px;height:11px;border-radius:999px;border:1px solid var(--lumiverse-startup-border,rgba(255,255,255,.12))}}.lumiverse-startup-pulse{{position:absolute;top:50%;left:50%;width:42px;height:42px;margin:-21px;border-radius:50%;border:2px solid var(--lumiverse-startup-primary,#9370db);border-left-color:transparent;opacity:.55;animation:lumiverse-startup-spin .9s linear infinite}}@keyframes lumiverse-startup-spin{{to{{transform:rotate(360deg)}}}}';
    document.head.appendChild(style);
    document.body.appendChild(shell);
    // React routes are ready after their first commit. Plain HTML callbacks
    // and other documents without a React root are ready once parsed.
    const mounted = () =>
      !!document.querySelector('[data-app-root]') ||
      (document.getElementById('root')?.childElementCount ?? 0) > 0 ||
      (!document.getElementById('root') && document.readyState !== 'loading');
    let timeout;
    const dismiss = () => {{
      shell.remove(); style.remove(); root.removeAttribute('data-lumiverse-startup-shell'); observer.disconnect();
      document.removeEventListener('DOMContentLoaded', remove);
      clearTimeout(timeout);
    }};
    const remove = () => {{
      if (!mounted()) return false;
      dismiss(); return true;
    }};
    const observer = new MutationObserver(remove);
    observer.observe(document.documentElement, {{ childList: true, subtree: true }});
    document.addEventListener('DOMContentLoaded', remove, {{ once: true }});
    requestAnimationFrame(remove);
    // Only a failsafe for a broken page; normal dismissal follows readiness.
    timeout = setTimeout(dismiss, 15000);
  }};
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount, {{ once: true }});
}})();"#
    )
}

fn load_bounds<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<(i32, i32, u32, u32)> {
    let file = bounds_file(app)?;
    let data = std::fs::read_to_string(file).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    let w = v.get("width")?.as_u64()? as u32;
    let h = v.get("height")?.as_u64()? as u32;
    if w == 0 || h == 0 {
        return None;
    }
    Some((
        v.get("x")?.as_i64()? as i32,
        v.get("y")?.as_i64()? as i32,
        w,
        h,
    ))
}

fn save_bounds_to_file<R: tauri::Runtime>(app: &AppHandle<R>, x: i32, y: i32, w: u32, h: u32) {
    if let Some(path) = bounds_file(app) {
        let json = serde_json::json!({ "x": x, "y": y, "width": w, "height": h });
        let _ = std::fs::write(
            path,
            serde_json::to_string_pretty(&json).unwrap_or_default(),
        );
    }
}

/// Clamp persisted physical-pixel bounds to a currently connected display's
/// work area. This avoids lost/off-screen windows after monitor or DPI changes.
fn sane_bounds(
    app: &AppHandle,
    (x, y, w, h): (i32, i32, u32, u32),
) -> Option<(i32, i32, u32, u32, f64)> {
    if w == 0 || h == 0 {
        return None;
    }

    let saved_left = i64::from(x);
    let saved_top = i64::from(y);
    let saved_right = saved_left + i64::from(w);
    let saved_bottom = saved_top + i64::from(h);
    let monitors = app.available_monitors().ok()?;
    let monitor = monitors
        .iter()
        .filter_map(|monitor| {
            let area = monitor.work_area();
            let left = i64::from(area.position.x);
            let top = i64::from(area.position.y);
            let right = left + i64::from(area.size.width);
            let bottom = top + i64::from(area.size.height);
            let overlap = (saved_right.min(right) - saved_left.max(left)).max(0)
                * (saved_bottom.min(bottom) - saved_top.max(top)).max(0);
            (overlap > 0).then_some((overlap, monitor))
        })
        .max_by_key(|(overlap, _)| *overlap)
        .map(|(_, monitor)| monitor)?;

    let area = monitor.work_area();
    let usable_width = area
        .size
        .width
        .saturating_sub((RESTORE_MARGIN * 2) as u32)
        .max(1);
    let usable_height = area
        .size
        .height
        .saturating_sub((RESTORE_MARGIN * 2) as u32)
        .max(1);
    let width = w.clamp(DEFAULT_WIDTH.min(usable_width), usable_width);
    let height = h.clamp(DEFAULT_HEIGHT.min(usable_height), usable_height);
    let min_x = area.position.x.saturating_add(RESTORE_MARGIN);
    let min_y = area.position.y.saturating_add(RESTORE_MARGIN);
    let max_x = area
        .position
        .x
        .saturating_add(area.size.width.min(i32::MAX as u32) as i32)
        .saturating_sub(width.min(i32::MAX as u32) as i32)
        .saturating_sub(RESTORE_MARGIN)
        .max(min_x);
    let max_y = area
        .position
        .y
        .saturating_add(area.size.height.min(i32::MAX as u32) as i32)
        .saturating_sub(height.min(i32::MAX as u32) as i32)
        .saturating_sub(RESTORE_MARGIN)
        .max(min_y);

    Some((
        x.clamp(min_x, max_x),
        y.clamp(min_y, max_y),
        width,
        height,
        monitor.scale_factor(),
    ))
}

fn persist_bounds<R: tauri::Runtime>(
    app: &AppHandle<R>,
    state: &FrontendState,
    window: &tauri::WebviewWindow<R>,
) {
    if let (Ok(pos), Ok(size)) = (window.inner_position(), window.inner_size()) {
        let bounds = (pos.x, pos.y, size.width, size.height);
        *state.bounds.lock().unwrap() = Some(bounds);
        save_bounds_to_file(app, bounds.0, bounds.1, bounds.2, bounds.3);
    }
}

/// Give the visible frontend its normal task-switcher presence, without
/// making the always-running tray host appear as a separate desktop app.
pub fn set_frontend_task_switcher_visible<R: tauri::Runtime>(
    app: &AppHandle<R>,
    window: &tauri::WebviewWindow<R>,
    visible: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    app.set_dock_visibility(visible)
        .map_err(|error| error.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = app;

    window
        .set_skip_taskbar(!visible)
        .map_err(|error| error.to_string())
}

pub fn hide_frontend_window<R: tauri::Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        let state = app.state::<FrontendState>();
        persist_bounds(app, &state, &window);
        let _ = window.hide();
        let _ = set_frontend_task_switcher_visible(app, &window, false);
        emit_frontend_presence(app, &window);
    }
}

// WebView2 creation deadlocks inside a synchronous Windows IPC callback.
// Dispatch on Tauri's worker pool there; macOS's WebKit configuration below
// requires the main thread. Use the same dispatch for every window creator.
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn show_frontend(
    app: AppHandle,
    port: u16,
    custom_url: Option<String>,
    state: State<'_, FrontendState>,
) -> Result<(), String> {
    // BetterAuth's default callback origin is localhost. Keep the embedded
    // frontend on that exact host so its host-scoped SSO cookie survives the
    // provider callback (127.0.0.1 is a distinct cookie origin).
    let target = custom_url.unwrap_or_else(|| format!("http://localhost:{port}"));
    let url: tauri::Url = target
        .parse()
        .map_err(|e| format!("Invalid Lumiverse frontend URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Frontend URL must start with http:// or https://".into());
    }

    #[cfg(target_os = "windows")]
    let rounded_windows =
        supports_windows_rounded_corners(windows_version::OsVersion::current().build);
    #[cfg(not(target_os = "windows"))]
    let rounded_windows = false;
    let windows_corners = if cfg!(target_os = "windows") {
        if rounded_windows {
            "rounded"
        } else {
            "square"
        }
    } else {
        ""
    };

    // Keep the current URL and in-memory frontend state when the frontend is
    // hidden and reopened. Only reset to the frontend root if its server port
    // has genuinely changed.
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        // Apply this on the reuse path too. The tray normally hides rather
        // than destroys the frontend window, so a newly changed shadow policy
        // must not wait for a full desktop-process restart.
        window
            .set_shadow(rounded_windows)
            .map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        enforce_frontend_content_corner_radius(&window)?;
        let target_changed = window
            .url()
            .map(|current| {
                current.scheme() != url.scheme()
                    || current.host_str() != url.host_str()
                    || current.port_or_known_default() != url.port_or_known_default()
            })
            .unwrap_or(true);
        if target_changed {
            window.navigate(url).map_err(|e| e.to_string())?;
        }
        set_frontend_task_switcher_visible(&app, &window, true)?;
        #[cfg(target_os = "macos")]
        app.show().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        emit_frontend_presence(&app, &window);
        return Ok(());
    }

    let startup_appearance = load_frontend_startup_appearance(&app);
    let native_background = if startup_appearance.blur {
        tauri::webview::Color(0, 0, 0, 0)
    } else {
        let [red, green, blue] = startup_appearance.native_color;
        tauri::webview::Color(red, green, blue, 255)
    };
    let popup_app = app.clone();
    let frontend_origin = url.origin().ascii_serialization();
    let mut builder = WebviewWindowBuilder::new(&app, FRONTEND_LABEL, WebviewUrl::External(url))
        .title(FRONTEND_TITLE)
        .disable_drag_drop_handler()
        .inner_size(DEFAULT_WIDTH as f64, DEFAULT_HEIGHT as f64)
        .min_inner_size(800.0, 600.0)
        // The frontend renders the title bar and window controls so it can
        // inherit the active Lumiverse theme on every desktop platform.
        .decorations(false)
        // The titlebar is rendered inside the WebView. On macOS an inactive
        // WebView otherwise consumes the first click only to activate the
        // window, so its drag region does not see that gesture.
        .accept_first_mouse(true)
        .shadow(rounded_windows)
        // The tray host starts without a Dock/taskbar entry. Enable the
        // frontend's entry immediately before its first show below.
        .skip_taskbar(true)
        // The frontend owns its own surface color. Keeping the native window
        // and WebView transparent lets a theme opt into a translucent body.
        // Opaque themes remain visually identical because their CSS body/app
        // surfaces cover the transparent host.
        .transparent(true)
        .background_color(native_background)
        // Install a lightweight titlebar/surface before the remote frontend's
        // bundle executes. It removes itself as soon as the app root mounts.
        .initialization_script(frontend_startup_shell_script(
            &startup_appearance,
            windows_corners,
            &frontend_origin,
        ))
        // Embedded WebViews do not provide a browser download shelf. Publish
        // the native lifecycle so the frontend can show immediate feedback.
        .on_download(report_frontend_download)
        // Wry denies window.open by default. SSO relies on a user-initiated
        // about:blank popup so the provider does not replace the companion's
        // main frontend. Reuse the opener's WebView configuration/environment;
        // that keeps cookies and window.opener available for the completion
        // page's authenticated handoff on macOS, Windows, and Linux.
        .on_new_window(move |popup_url, features| {
            if !matches!(popup_url.scheme(), "about" | "http" | "https") {
                return tauri::webview::NewWindowResponse::Deny;
            }

            let popup_id = NEXT_FRONTEND_POPUP_ID.fetch_add(1, Ordering::Relaxed);
            let label = format!("frontend-popup-{popup_id}");
            let popup = configure_webview_runtime(WebviewWindowBuilder::new(
                &popup_app,
                &label,
                WebviewUrl::External(popup_url),
            ))
            .title("Lumiverse Sign-In")
            .window_features(features)
            .on_document_title_changed(|window, title| {
                let _ = window.set_title(&title);
            })
            .build();

            match popup {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(error) => {
                    eprintln!("[desktop-window] could not create frontend popup: {error}");
                    tauri::webview::NewWindowResponse::Deny
                }
            }
        })
        .visible(false);
    builder = configure_webview_runtime(builder);

    // Quality mode opts into the high-refresh WebView configuration where
    // macOS supports it. Balanced and efficiency retain WebKit's stock policy.
    #[cfg(target_os = "macos")]
    {
        if startup_appearance.high_refresh {
            if let Some(configuration) = high_refresh_webview_configuration() {
                builder = builder.with_webview_configuration(configuration);
            }
        }
    }

    let saved_bounds = state
        .bounds
        .lock()
        .unwrap()
        .clone()
        .or_else(|| load_bounds(&app));
    if let Some((x, y, w, h, scale)) = saved_bounds.and_then(|bounds| sane_bounds(&app, bounds)) {
        builder = builder
            .position(x as f64 / scale, y as f64 / scale)
            .inner_size(w as f64 / scale, h as f64 / scale);
        *state.bounds.lock().unwrap() = Some((x, y, w, h));
    } else {
        *state.bounds.lock().unwrap() = None;
        builder = builder.center();
    }

    let window = builder.build().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    crate::webview_media::configure_frontend_microphone(&window)?;
    // Applying this again after construction keeps a hot-reloaded frontend
    // from inheriting caption buttons from a previously decorated platform
    // window. A full desktop-process restart is still required to replace an
    // already-created native window.
    window.set_decorations(false).map_err(|e| e.to_string())?;
    window
        .set_shadow(rounded_windows)
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    enforce_frontend_content_corner_radius(&window)?;
    // A newly-created hidden GTK window does not have a wl_surface yet. Apply
    // the Wayland effect after `show` below; the other platforms can install
    // their native material before the first visible frame.
    #[cfg(not(target_os = "linux"))]
    apply_frontend_native_appearance(
        &window,
        startup_appearance.blur,
        startup_appearance.dark,
        &startup_appearance.blur_intensity,
    )?;
    // Keep the frontend available from the tray after the user clicks the
    // native close button.
    let close_window = window.clone();
    let close_app = app.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_frontend_window(&close_app);
            }
            // Tauri exposes focus directly. Minimize/restore is represented by
            // a resize event on the desktop runtimes, so re-query all native
            // flags after either transition instead of guessing from web APIs.
            WindowEvent::Focused(_) => {
                emit_frontend_presence(&close_app, &close_window);
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                emit_frontend_presence(&close_app, &close_window);
                #[cfg(target_os = "linux")]
                if let Err(error) =
                    crate::wayland_background_effect::refresh_background_effect(&close_window)
                {
                    eprintln!(
                        "[desktop-appearance] failed to resize Wayland background effect: {error}"
                    );
                }
            }
            WindowEvent::Destroyed => {
                #[cfg(target_os = "linux")]
                if let Err(error) =
                    crate::wayland_background_effect::clear_background_effects(&close_window)
                {
                    eprintln!(
                        "[desktop-appearance] failed to clear Wayland background effect: {error}"
                    );
                }
            }
            _ => {}
        }
    });
    // `tauri dev` runs a debug build, where the inspector is available.
    #[cfg(debug_assertions)]
    window.open_devtools();
    set_frontend_task_switcher_visible(&app, &window, true)?;
    // On macOS `show` unhides the NSApplication. Calling it before focusing
    // ensures the active app (and therefore the menu bar) becomes Lumiverse.
    #[cfg(target_os = "macos")]
    app.show().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    apply_frontend_native_appearance(
        &window,
        startup_appearance.blur,
        startup_appearance.dark,
        &startup_appearance.blur_intensity,
    )?;
    window.set_focus().map_err(|e| e.to_string())?;
    emit_frontend_presence(&app, &window);
    Ok(())
}

/// Destroy the integrated browser and every extension widget hosted by it.
/// The catalog belongs to the browser's live page, so discard it as part of
/// the same operation; a newly opened browser will publish a fresh catalog.
#[tauri::command]
pub fn close_frontend(
    app: AppHandle,
    widget_state: State<'_, DesktopWidgetCatalogState>,
) -> Result<(), String> {
    let widgets = std::mem::take(&mut *widget_state.widgets.lock().unwrap());
    let mut failures = Vec::new();

    for widget in &widgets {
        if let Some(window) = app.get_webview_window(&extension_widget_label(widget)) {
            if let Err(error) = window.destroy() {
                failures.push(format!("{}: {error}", widget.title));
            }
        }
    }

    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        let state = app.state::<FrontendState>();
        persist_bounds(&app, &state, &window);
        let _ = set_frontend_task_switcher_visible(&app, &window, false);
        // Queue protocol-object cleanup before GTK destroys the wl_surface.
        // The Destroyed handler remains as a defensive fallback for native
        // destruction paths that do not pass through this command.
        #[cfg(target_os = "linux")]
        let _ = crate::wayland_background_effect::clear_background_effects(&window);
        if let Err(error) = window.destroy() {
            failures.push(format!("integrated browser: {error}"));
        }
    }

    app.emit_to(
        "main",
        "desktop-widget-catalog",
        Vec::<DesktopWidgetDescriptor>::new(),
    )
    .map_err(|error| error.to_string())?;

    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Unable to close every desktop window: {}",
            failures.join(", ")
        ))
    }
}

/// Reload the current frontend URL, bringing a hidden frontend back first.
/// This preserves the user's route (and its query/hash) while reconnecting to
/// a restarted server or refreshing frontend assets.
#[tauri::command]
pub fn reload_frontend(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(FRONTEND_LABEL)
        .ok_or("Frontend is not open")?;
    set_frontend_task_switcher_visible(&app, &window, true)?;
    #[cfg(target_os = "macos")]
    app.show().map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    emit_frontend_presence(&app, &window);
    window.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_frontend_bounds(
    app: AppHandle,
    state: State<'_, FrontendState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) {
    *state.bounds.lock().unwrap() = Some((x, y, width, height));
    save_bounds_to_file(&app, x, y, width, height);
}

#[tauri::command]
pub fn frontend_visible(app: AppHandle) -> bool {
    app.get_webview_window(FRONTEND_LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}

/// Return a point-in-time native presence snapshot. The frontend calls this
/// after registering its event listener so reconnects and WebView reloads do
/// not depend on having observed every earlier window event.
#[tauri::command]
pub fn frontend_presence(app: AppHandle) -> Option<FrontendPresence> {
    app.get_webview_window(FRONTEND_LABEL)
        .map(|window| frontend_presence_for_window(&window))
}

#[tauri::command]
pub fn frontend_exists(app: AppHandle) -> bool {
    app.get_webview_window(FRONTEND_LABEL).is_some()
}

/// The frontend owns the live Spindle placement registry. It publishes only
/// serializable metadata here; the desktop host validates and reflects it in
/// the tray instead of granting the frontend arbitrary window creation.
#[tauri::command]
pub fn set_desktop_widget_catalog(
    app: AppHandle,
    state: State<'_, DesktopWidgetCatalogState>,
    widgets: Vec<DesktopWidgetDescriptor>,
) -> Result<(), String> {
    if widgets.len() > 32
        || widgets
            .iter()
            .any(|widget| !valid_widget_descriptor(widget))
    {
        return Err("Invalid floating-widget catalog".into());
    }
    let mut ids = std::collections::HashSet::new();
    if widgets.iter().any(|widget| !ids.insert(widget.id.as_str())) {
        return Err("Floating-widget catalog has duplicate IDs".into());
    }
    let removed_widgets = {
        let mut catalog = state.widgets.lock().unwrap();
        let removed = catalog
            .iter()
            .filter(|widget| !ids.contains(widget.id.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        *catalog = widgets.clone();
        removed
    };
    // A disabled extension disappears from the frontend-owned catalog. Close
    // any already-open native widget at the same time so stale Suite UI cannot
    // remain usable in a child WebView.
    for widget in &removed_widgets {
        if let Some(window) = app.get_webview_window(&extension_widget_label(widget)) {
            window.close().map_err(|error| error.to_string())?;
        }
    }
    // Widget state can change in the primary frontend (for example when an
    // extension expands its own UI). Reflect that change into an already open
    // child window rather than leaving it at the size it had when it opened.
    for widget in &widgets {
        if let Some(window) = app.get_webview_window(&extension_widget_label(widget)) {
            let height = widget
                .height
                .saturating_add(if widget.chromeless { 0 } else { 30 });
            window
                .set_size(LogicalSize::new(f64::from(widget.width), f64::from(height)))
                .map_err(|error| error.to_string())?;
        }
    }
    app.emit_to("main", "desktop-widget-catalog", widgets)
        .map_err(|error| error.to_string())
}

/// Accept a size reported by a native widget child. The label check prevents
/// one extension window from changing another extension's catalog entry.
#[tauri::command]
pub fn sync_desktop_widget_size(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopWidgetCatalogState>,
    widget_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let updated = {
        let mut widgets = state.widgets.lock().unwrap();
        let widget = widgets
            .iter_mut()
            .find(|entry| entry.id == widget_id)
            .ok_or("That floating widget is no longer registered")?;
        if window.label() != extension_widget_label(widget) {
            return Err("A widget window may only resize itself".into());
        }
        if !valid_widget_size(widget.chromeless, width, height) {
            return Err("Invalid floating-widget size".into());
        }
        widget.width = width;
        widget.height = height;
        widget.clone()
    };
    app.emit_to("main", "desktop-widget-size", updated)
        .map_err(|error| error.to_string())
}

/// The primary frontend sends this immediately after an extension calls
/// FloatWidgetHandle.setSize. It closes the timing gap between the in-memory
/// placement change and the next tray-catalog publication.
#[tauri::command]
pub fn resize_extension_widget(
    app: AppHandle,
    state: State<'_, DesktopWidgetCatalogState>,
    widget_id: String,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let widget = {
        let mut widgets = state.widgets.lock().unwrap();
        let widget = widgets
            .iter_mut()
            .find(|entry| entry.id == widget_id)
            .ok_or("That floating widget is no longer registered")?;
        if !valid_widget_size(widget.chromeless, width, height) {
            return Err("Invalid floating-widget size".into());
        }
        widget.width = width;
        widget.height = height;
        widget.clone()
    };
    eprintln!(
        "[desktop-widget] received primary resize request id={} width={} height={}",
        widget.id, widget.width, widget.height
    );
    if let Some(window) = app.get_webview_window(&extension_widget_label(&widget)) {
        let height = widget
            .height
            .saturating_add(if widget.chromeless { 0 } else { 30 });
        window
            .set_size(LogicalSize::new(f64::from(widget.width), f64::from(height)))
            .map_err(|error| error.to_string())?;
        eprintln!(
            "[desktop-widget] applied primary resize request id={}",
            widget.id
        );
    } else {
        eprintln!(
            "[desktop-widget] no open pop-out for resize request id={}",
            widget.id
        );
    }
    Ok(())
}

#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn show_extension_widget(
    app: AppHandle,
    state: State<'_, DesktopWidgetCatalogState>,
    widget_id: String,
) -> Result<(), String> {
    let widget = state
        .widgets
        .lock()
        .unwrap()
        .iter()
        .find(|entry| entry.id == widget_id)
        .cloned()
        .ok_or("That floating widget is no longer registered")?;
    let frontend = app
        .get_webview_window(FRONTEND_LABEL)
        .ok_or("Open the integrated browser before popping out an extension widget")?;
    let mut url = frontend.url().map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The current Lumiverse frontend cannot host extension widgets".into());
    }
    url.set_path("/widget.html");
    url.set_fragment(None);
    {
        let mut query = url.query_pairs_mut();
        query.clear();
        query.append_pair("desktopWidgetExtension", &widget.extension_id);
        query.append_pair("desktopWidgetIndex", &widget.index.to_string());
        query.append_pair("desktopWidgetTitle", &widget.title);
        query.append_pair(
            "desktopWidgetChromeless",
            if widget.chromeless { "1" } else { "0" },
        );
        query.append_pair("desktopWidgetWidth", &widget.width.to_string());
        query.append_pair("desktopWidgetHeight", &widget.height.to_string());
    }

    let label = extension_widget_label(&widget);
    if let Some(window) = app.get_webview_window(&label) {
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        // A non-focusable macOS window activates the application's last
        // focusable window when clicked. That can restore the minimized main
        // frontend; let the pop-out become key instead.
        window
            .set_focusable(true)
            .map_err(|error| error.to_string())?;
        window
            .set_shadow(false)
            .map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
    } else {
        let builder = configure_webview_runtime(WebviewWindowBuilder::new(
            &app,
            &label,
            WebviewUrl::External(url),
        ))
        .title(&widget.title)
        .inner_size(
            f64::from(widget.width),
            f64::from(
                widget
                    .height
                    .saturating_add(if widget.chromeless { 0 } else { 30 }),
            ),
        )
        .min_inner_size(
            if widget.chromeless {
                f64::from(CHROMELESS_WIDGET_MIN_SIZE)
            } else {
                f64::from(CHROMED_WIDGET_MIN_WIDTH)
            },
            if widget.chromeless {
                f64::from(CHROMELESS_WIDGET_MIN_SIZE)
            } else {
                f64::from(CHROMED_WIDGET_MIN_HEIGHT + 30)
            },
        )
        .decorations(false)
        // Widgets already draw their own visual edge. A native shadow
        // becomes a conspicuous border around transparent content.
        .shadow(false)
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        // Keep creation non-activating while still delivering the user's
        // first deliberate click to the WebView's controls/drag regions.
        .accept_first_mouse(true)
        // Do not take focus when it opens, but accept focus from a click
        // so the operating system does not redirect that activation to
        // the minimized main frontend window.
        .focusable(true)
        .resizable(true)
        .visible(false);
        let window = builder.build().map_err(|error| error.to_string())?;
        window
            .set_shadow(false)
            .map_err(|error| error.to_string())?;
        let close_app = app.clone();
        let close_widget_id = widget.id.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { .. } = event {
                let _ = emit_widget_popout_state(&close_app, close_widget_id.clone(), false);
            }
        });
        window.show().map_err(|error| error.to_string())?;
    }
    emit_widget_popout_state(&app, widget.id, true)?;
    Ok(())
}

/// Close a native widget and mount its registered root back in the main
/// frontend. The calling child is checked so a pop-out cannot return some
/// other extension's widget.
#[tauri::command]
pub fn return_extension_widget(
    window: WebviewWindow,
    state: State<'_, DesktopWidgetCatalogState>,
    widget_id: String,
) -> Result<(), String> {
    let widget = state
        .widgets
        .lock()
        .unwrap()
        .iter()
        .find(|entry| entry.id == widget_id)
        .cloned()
        .ok_or("That floating widget is no longer registered")?;
    if window.label() != extension_widget_label(&widget) {
        return Err("A widget window may only return itself to the page".into());
    }
    window.close().map_err(|error| error.to_string())
}

/// Tray equivalent of `return_extension_widget`. The tray is part of the
/// trusted native host, so it can return any registered widget on the user's
/// behalf without pretending to be a widget WebView.
#[tauri::command]
pub fn return_extension_widget_from_tray(
    app: AppHandle,
    state: State<'_, DesktopWidgetCatalogState>,
    widget_id: String,
) -> Result<(), String> {
    let widget = state
        .widgets
        .lock()
        .unwrap()
        .iter()
        .find(|entry| entry.id == widget_id)
        .cloned()
        .ok_or("That floating widget is no longer registered")?;
    if let Some(window) = app.get_webview_window(&extension_widget_label(&widget)) {
        window.close().map_err(|error| error.to_string())?;
        return Ok(());
    }
    emit_widget_popout_state(&app, widget.id, false)
}

/// Apply the native material behind an opt-in translucent frontend theme.
/// The document provides the color/tint itself, while the native effect
/// supplies the platform blur. This is shared by the launch snapshot and the
/// live frontend command, so their first and steady-state frames agree.
#[cfg(any(target_os = "windows", test))]
fn supports_windows_rounded_corners(build: u32) -> bool {
    build >= 22_000
}

#[cfg(any(target_os = "windows", test))]
fn supports_windows_system_backdrop(build: u32) -> bool {
    // This is the same cutoff used by window-vibrancy 0.6 before it selects
    // DWMWA_SYSTEMBACKDROP_TYPE instead of SetWindowCompositionAttribute.
    build >= 22_523
}

fn apply_frontend_native_appearance(
    window: &WebviewWindow,
    blur: bool,
    dark: bool,
    blur_intensity: &str,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{
            apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial, NSVisualEffectState,
        };

        // The semantic macOS material follows the system appearance itself.
        let _ = dark;
        // Tauri 2.11 does not clear macOS vibrancy when `set_effects(None)` is
        // called. Manage the tagged NSVisualEffectView directly so blur can be
        // disabled while retaining a translucent document tint.
        let material = blur.then(|| match blur_intensity {
            "subtle" => NSVisualEffectMaterial::WindowBackground,
            "strong" => NSVisualEffectMaterial::HudWindow,
            _ => NSVisualEffectMaterial::Sidebar,
        });
        let window_for_effect = window.clone();

        window
            .run_on_main_thread(move || {
                if let Err(error) = clear_vibrancy(&window_for_effect) {
                    eprintln!("[desktop-appearance] failed to clear macOS material: {error}");
                    return;
                }
                if let Some(material) = material {
                    if let Err(error) = apply_vibrancy(
                        &window_for_effect,
                        material,
                        Some(NSVisualEffectState::Active),
                        None,
                    ) {
                        eprintln!("[desktop-appearance] failed to apply macOS material: {error}");
                    }
                }
            })
            .map_err(|error| error.to_string())?;
    }

    #[cfg(target_os = "windows")]
    {
        use tauri::window::{Effect, EffectsBuilder};

        // Windows system backdrops do not expose a blur-radius selection.
        let _ = (dark, blur_intensity);
        if blur {
            let windows_build = windows_version::OsVersion::current().build;
            let effect = if supports_windows_system_backdrop(windows_build) {
                // On current Windows 11, Acrylic maps to the supported
                // DWMSBT_TRANSIENTWINDOW backdrop. The previous Blur effect
                // uses the legacy ACCENT_ENABLE_BLURBEHIND path, which flickers
                // badly while a window is dragged or resized on build 22621+.
                Effect::Acrylic
            } else {
                // Older Windows releases do not have the system-backdrop API.
                // Keep the existing frosted blur there; Acrylic would also use
                // a legacy accent policy and performs worse on Windows 10.
                Effect::Blur
            };
            window
                .set_effects(EffectsBuilder::new().effect(effect).build())
                .map_err(|error| error.to_string())?;
        } else {
            window
                .set_effects(None)
                .map_err(|error| error.to_string())?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        // The protocol deliberately leaves the blur algorithm/intensity to the
        // compositor. The page continues to provide Lumiverse's tint.
        let _ = (dark, blur_intensity);
        crate::wayland_background_effect::set_background_effect(window, blur)?;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = (window, blur, dark, blur_intensity);
    }

    Ok(())
}

/// Apply the native material behind an opt-in translucent frontend theme.
///
/// The document provides the color/tint itself, while the native effect
/// supplies the platform blur. Unsupported platforms deliberately no-op so
/// the same theme remains usable as a regular translucent CSS surface.
#[tauri::command]
pub fn configure_frontend_appearance(
    app: AppHandle,
    blur: bool,
    dark: bool,
    blur_intensity: Option<String>,
) -> Result<(), String> {
    #[cfg(debug_assertions)]
    eprintln!(
        "[desktop-appearance] native-effect request: blur={blur}, dark={dark}, intensity={blur_intensity:?}"
    );

    let window = app
        .get_webview_window(FRONTEND_LABEL)
        .ok_or("Frontend is not open")?;
    apply_frontend_native_appearance(
        &window,
        blur,
        dark,
        blur_intensity.as_deref().unwrap_or("balanced"),
    )
}

/// Persist the last resolved page surface and titlebar palette. It is limited
/// to simple CSS token values and is only used as a non-interactive launch
/// shell before the actual frontend is ready.
#[tauri::command]
pub fn cache_frontend_startup_appearance(
    app: AppHandle,
    appearance: FrontendStartupAppearance,
) -> Result<(), String> {
    if !valid_startup_appearance(&appearance) {
        return Err("Invalid frontend startup appearance".into());
    }
    save_frontend_startup_appearance(&app, &appearance)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        download_file_name, frontend_startup_shell_script, is_frontend_popup_label,
        supports_windows_rounded_corners, supports_windows_system_backdrop, valid_widget_size,
        FrontendStartupAppearance,
    };

    #[test]
    fn rounds_only_supported_windows_frames() {
        assert!(!supports_windows_rounded_corners(19_045));
        assert!(!supports_windows_rounded_corners(21_999));
        assert!(supports_windows_rounded_corners(22_000));

        let appearance = FrontendStartupAppearance::default();
        let rounded =
            frontend_startup_shell_script(&appearance, "rounded", "http://localhost:3000");
        let square = frontend_startup_shell_script(&appearance, "square", "http://localhost:3000");
        assert!(rounded.contains("border-radius:8px 8px 0 0;overflow:hidden"));
        assert!(square.contains("border-radius:0px 0px 0 0;overflow:hidden"));
    }

    #[test]
    fn selects_system_backdrops_at_window_vibrancy_cutoff() {
        assert!(!supports_windows_system_backdrop(22_522));
        assert!(supports_windows_system_backdrop(22_523));
        assert!(supports_windows_system_backdrop(26_200));
    }

    #[test]
    fn recognizes_only_generated_frontend_popup_labels() {
        assert!(is_frontend_popup_label("frontend-popup-1"));
        assert!(is_frontend_popup_label("frontend-popup-2048"));
        assert!(!is_frontend_popup_label("frontend"));
        assert!(!is_frontend_popup_label("frontend-popup-"));
        assert!(!is_frontend_popup_label("frontend-popup-settings"));
        assert!(!is_frontend_popup_label("frontend-popup-1-other"));
    }

    #[test]
    fn download_name_prefers_the_native_destination() {
        let url = "http://localhost:3000/characters/123/export"
            .parse()
            .unwrap();
        assert_eq!(
            download_file_name(&url, Some(Path::new("/tmp/Alice.charx"))),
            "Alice.charx"
        );
        assert_eq!(download_file_name(&url, None), "export");
    }

    #[test]
    fn chromeless_widgets_can_contract_to_their_visible_surface() {
        assert!(valid_widget_size(true, 48, 48));
        assert!(!valid_widget_size(false, 48, 48));
        assert!(valid_widget_size(false, 160, 100));
        assert!(!valid_widget_size(true, 23, 48));
    }
}

/// Show the small native settings window used to configure a cloud frontend.
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn show_frontend_url_settings(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "frontend-url-settings";
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }

    let window = configure_webview_runtime(WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("custom-url.html".into()),
    ))
    .title("Instance Connection")
    .inner_size(560.0, 480.0)
    .min_inner_size(560.0, 480.0)
    .max_inner_size(560.0, 480.0)
    .resizable(false)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
