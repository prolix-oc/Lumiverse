//! Frontend window — a native WebView loading the local Lumiverse server.

use std::{path::PathBuf, sync::Mutex};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

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

    const CORNER_RADIUS: f64 = 12.0;
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
            let _: () = msg_send![layer, setCornerRadius: CORNER_RADIUS];
            let _: () = msg_send![layer, setMasksToBounds: true];
        })
        .map_err(|error| error.to_string())?;
    Ok(())
}

const FRONTEND_LABEL: &str = "frontend";
const WIDGET_POC_LABEL: &str = "widget-poc";
const FRONTEND_TITLE: &str = "Lumiverse";
const DEFAULT_WIDTH: u32 = 1200;
const DEFAULT_HEIGHT: u32 = 800;
const RESTORE_MARGIN: i32 = 24;
const FRONTEND_STARTUP_APPEARANCE_FILE: &str = "frontend_startup_appearance.json";

#[derive(Default)]
pub struct FrontendState {
    /// Persisted window bounds: (x, y, width, height) or None for defaults.
    bounds: Mutex<Option<(i32, i32, u32, u32)>>,
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
        }
    }
}

/// State owned by the native host rather than the widget WebView. Once a
/// window ignores cursor events it cannot receive the click that would turn
/// them back on, so the tray restores input for this proof of concept.
#[derive(Default)]
pub struct WidgetPocState {
    click_through: Mutex<bool>,
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
    app.emit_to(
        "main",
        "desktop-widget-popout-state",
        DesktopWidgetPopoutState {
            id: widget_id,
            popped_out,
        },
    )
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
        && (160..=1200).contains(&widget.width)
        && (100..=900).contains(&widget.height)
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

fn frontend_startup_shell_script(appearance: &FrontendStartupAppearance) -> String {
    let snapshot = serde_json::to_string(appearance).unwrap_or_else(|_| "{}".into());
    format!(
        r#"(() => {{
  const snapshot = {snapshot};
  const root = document.documentElement;
  const set = (name, value) => {{ if (typeof value === 'string') root.style.setProperty(name, value); }};
  set('--lumiverse-startup-background', snapshot.background);
  set('--lumiverse-startup-border', snapshot.border);
  set('--lumiverse-startup-text-muted', snapshot.textMuted);
  set('--lumiverse-startup-primary', snapshot.primary);
  root.setAttribute('data-lumiverse-startup-shell', '');

  const mount = () => {{
    if (document.getElementById('lumiverse-startup-shell')) return;
    const shell = document.createElement('div');
    shell.id = 'lumiverse-startup-shell';
    shell.setAttribute('aria-hidden', 'true');
    shell.innerHTML = '<div class="lumiverse-startup-titlebar"><span class="lumiverse-startup-dot"></span><span>Lumiverse</span><span class="lumiverse-startup-controls"><i></i><i></i><i></i></span></div><div class="lumiverse-startup-pulse"></div>';
    const style = document.createElement('style');
    style.textContent = '#lumiverse-startup-shell{{position:fixed;inset:0;z-index:2147483647;pointer-events:none;background:var(--lumiverse-startup-background,#0a0812);color:var(--lumiverse-startup-text-muted,rgba(255,255,255,.64));font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;letter-spacing:.02em}}.lumiverse-startup-titlebar{{height:36px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;border-bottom:1px solid var(--lumiverse-startup-border,rgba(255,255,255,.08));background:color-mix(in srgb,var(--lumiverse-startup-background,#0a0812) 86%,transparent)}}.lumiverse-startup-dot{{width:8px;height:8px;border-radius:999px;background:var(--lumiverse-startup-primary,#9370db);box-shadow:0 0 0 3px color-mix(in srgb,var(--lumiverse-startup-primary,#9370db) 12%,transparent)}}.lumiverse-startup-controls{{position:absolute;right:12px;display:flex;gap:7px}}.lumiverse-startup-controls i{{display:block;width:11px;height:11px;border-radius:999px;border:1px solid var(--lumiverse-startup-border,rgba(255,255,255,.12))}}.lumiverse-startup-pulse{{position:absolute;top:50%;left:50%;width:42px;height:42px;margin:-21px;border-radius:50%;border:2px solid var(--lumiverse-startup-primary,#9370db);border-left-color:transparent;opacity:.55;animation:lumiverse-startup-spin .9s linear infinite}}@keyframes lumiverse-startup-spin{{to{{transform:rotate(360deg)}}}}';
    document.head.appendChild(style);
    document.body.appendChild(shell);
    const remove = () => {{
      if (!document.querySelector('[data-app-root]')) return false;
      shell.remove(); style.remove(); root.removeAttribute('data-lumiverse-startup-shell'); observer.disconnect(); return true;
    }};
    const observer = new MutationObserver(remove);
    observer.observe(document.documentElement, {{ childList: true, subtree: true }});
    requestAnimationFrame(remove);
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
    }
}

#[tauri::command]
pub fn show_frontend(
    app: AppHandle,
    port: u16,
    custom_url: Option<String>,
    state: State<'_, FrontendState>,
) -> Result<(), String> {
    let target = custom_url.unwrap_or_else(|| format!("http://127.0.0.1:{port}"));
    let url: tauri::Url = target
        .parse()
        .map_err(|e| format!("Invalid Lumiverse frontend URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Frontend URL must start with http:// or https://".into());
    }

    // Keep the current URL and in-memory frontend state when the frontend is
    // hidden and reopened. Only reset to the frontend root if its server port
    // has genuinely changed.
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        // Apply this on the reuse path too. The tray normally hides rather
        // than destroys the frontend window, so a newly changed shadow policy
        // must not wait for a full desktop-process restart.
        window.set_shadow(false).map_err(|e| e.to_string())?;
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
        return Ok(());
    }

    let startup_appearance = load_frontend_startup_appearance(&app);
    let native_background = if startup_appearance.blur {
        tauri::webview::Color(0, 0, 0, 0)
    } else {
        let [red, green, blue] = startup_appearance.native_color;
        tauri::webview::Color(red, green, blue, 255)
    };
    let mut builder = WebviewWindowBuilder::new(&app, FRONTEND_LABEL, WebviewUrl::External(url))
        .title(FRONTEND_TITLE)
        .inner_size(DEFAULT_WIDTH as f64, DEFAULT_HEIGHT as f64)
        .min_inner_size(800.0, 600.0)
        // The frontend renders the title bar and window controls so it can
        // inherit the active Lumiverse theme on every desktop platform.
        .decorations(false)
        // The frontend owns its rounded document edge. A native shadow creates
        // a square-ish outline around that curve on transparent windows.
        .shadow(false)
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
        .initialization_script(frontend_startup_shell_script(&startup_appearance))
        .visible(false);

    // Use the high-refresh WebView configuration where macOS supports it. The
    // frontend supplies dragging and window controls for this frameless shell.
    #[cfg(target_os = "macos")]
    {
        if let Some(configuration) = high_refresh_webview_configuration() {
            builder = builder.with_webview_configuration(configuration);
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
    // Applying this again after construction keeps a hot-reloaded frontend
    // from inheriting caption buttons from a previously decorated platform
    // window. A full desktop-process restart is still required to replace an
    // already-created native window.
    window.set_decorations(false).map_err(|e| e.to_string())?;
    window.set_shadow(false).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    enforce_frontend_content_corner_radius(&window)?;
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
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let state = close_app.state::<FrontendState>();
            persist_bounds(&close_app, &state, &close_window);
            let _ = close_window.hide();
            let _ = set_frontend_task_switcher_visible(&close_app, &close_window, false);
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
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn hide_frontend(app: AppHandle, state: State<'_, FrontendState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(FRONTEND_LABEL) {
        persist_bounds(&app, &state, &window);
        let _ = window.hide();
        let _ = set_frontend_task_switcher_visible(&app, &window, false);
    }
    Ok(())
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
    *state.widgets.lock().unwrap() = widgets.clone();
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
    if !(160..=1200).contains(&width) || !(100..=900).contains(&height) {
        return Err("Invalid floating-widget size".into());
    }
    let updated = {
        let mut widgets = state.widgets.lock().unwrap();
        let widget = widgets
            .iter_mut()
            .find(|entry| entry.id == widget_id)
            .ok_or("That floating widget is no longer registered")?;
        if window.label() != extension_widget_label(widget) {
            return Err("A widget window may only resize itself".into());
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
    if !(160..=1200).contains(&width) || !(100..=900).contains(&height) {
        return Err("Invalid floating-widget size".into());
    }
    let widget = {
        let mut widgets = state.widgets.lock().unwrap();
        let widget = widgets
            .iter_mut()
            .find(|entry| entry.id == widget_id)
            .ok_or("That floating widget is no longer registered")?;
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

#[tauri::command]
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
        .ok_or("Open Lumiverse before popping out an extension widget")?;
    let mut url = frontend.url().map_err(|error| error.to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The current Lumiverse frontend cannot host extension widgets".into());
    }
    url.set_path("/");
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
        let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
            .title(&widget.title)
            .inner_size(
                f64::from(widget.width),
                f64::from(
                    widget
                        .height
                        .saturating_add(if widget.chromeless { 0 } else { 30 }),
                ),
            )
            .min_inner_size(160.0, if widget.chromeless { 100.0 } else { 130.0 })
            .decorations(false)
            // Widgets already draw their own visual edge. A native shadow
            // becomes a conspicuous border around transparent content.
            .shadow(false)
            .transparent(true)
            .background_color(tauri::webview::Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
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
        let close_window = window.clone();
        let close_app = app.clone();
        let close_widget_id = widget.id.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = close_window.hide();
                let _ = emit_widget_popout_state(&close_app, close_widget_id.clone(), false);
            }
        });
        window.show().map_err(|error| error.to_string())?;
    }
    emit_widget_popout_state(&app, widget.id, true)?;
    Ok(())
}

/// Hide a native widget and mount its registered root back in the main
/// frontend. The calling child is checked so a pop-out cannot return some
/// other extension's widget.
#[tauri::command]
pub fn return_extension_widget(
    app: AppHandle,
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
    window.hide().map_err(|error| error.to_string())?;
    emit_widget_popout_state(&app, widget.id, false)
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
        window.hide().map_err(|error| error.to_string())?;
    }
    emit_widget_popout_state(&app, widget.id, false)
}

/// Create a small local WebView window that demonstrates the primitives an
/// extension-provided floating widget will need. The actual extension bridge
/// comes later; keeping this page app-local avoids giving a remote frontend
/// permission to create arbitrary native windows.
#[tauri::command]
pub fn show_widget_poc(app: AppHandle, state: State<'_, WidgetPocState>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WIDGET_POC_LABEL) {
        window
            .set_ignore_cursor_events(false)
            .map_err(|e| e.to_string())?;
        *state.click_through.lock().unwrap() = false;
        window.set_shadow(false).map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewWindowBuilder::new(
        &app,
        WIDGET_POC_LABEL,
        WebviewUrl::App("widget.html".into()),
    )
    .title("Lumiverse widget")
    .inner_size(330.0, 220.0)
    .min_inner_size(250.0, 160.0)
    .decorations(false)
    .shadow(false)
    .transparent(true)
    .background_color(tauri::webview::Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .resizable(true)
    .visible(false);

    let window = builder.build().map_err(|e| e.to_string())?;
    let close_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = close_window.hide();
        }
    });
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn hide_widget_poc(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WIDGET_POC_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_widget_poc_click_through(
    app: AppHandle,
    state: State<'_, WidgetPocState>,
    enabled: bool,
) -> Result<(), String> {
    let window = app
        .get_webview_window(WIDGET_POC_LABEL)
        .ok_or("Floating widget POC is not open")?;
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    *state.click_through.lock().unwrap() = enabled;
    Ok(())
}

#[tauri::command]
pub fn toggle_widget_poc_click_through(
    app: AppHandle,
    state: State<'_, WidgetPocState>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(WIDGET_POC_LABEL)
        .ok_or("Floating widget POC is not open")?;
    let enabled = {
        let click_through = state.click_through.lock().unwrap();
        !*click_through
    };
    window
        .set_ignore_cursor_events(enabled)
        .map_err(|e| e.to_string())?;
    *state.click_through.lock().unwrap() = enabled;
    Ok(())
}

/// Apply the native material behind an opt-in translucent frontend theme.
/// The document provides the color/tint itself, while the native effect
/// supplies the platform blur. This is shared by the launch snapshot and the
/// live frontend command, so their first and steady-state frames agree.
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

        if blur {
            // Mica is a wallpaper-tint material, not a blur effect, and the
            // content beneath it remains visually crisp. The desktop theme's
            // "Blur" switch promises an actual frosted surface, so use DWM
            // blur here. The document still supplies the theme tint above it.
            let _ = dark;
            window
                .set_effects(EffectsBuilder::new().effect(Effect::Blur).build())
                .map_err(|error| error.to_string())?;
        } else {
            window
                .set_effects(None)
                .map_err(|error| error.to_string())?;
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
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

/// Show the small native settings window used to configure a cloud frontend.
#[tauri::command]
pub fn show_frontend_url_settings(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "frontend-url-settings";
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }

    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("custom-url.html".into()))
        .title("Frontend URL")
        .inner_size(480.0, 260.0)
        .min_inner_size(480.0, 260.0)
        .max_inner_size(480.0, 260.0)
        .resizable(false)
        .center()
        .build()
        .map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}
