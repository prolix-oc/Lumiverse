//! Frontend window — a native WebView loading the local Lumiverse server.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

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

const FRONTEND_LABEL: &str = "frontend";
const FRONTEND_TITLE: &str = "Lumiverse";
const DEFAULT_WIDTH: u32 = 1200;
const DEFAULT_HEIGHT: u32 = 800;
const RESTORE_MARGIN: i32 = 24;

#[derive(Default)]
pub struct FrontendState {
    /// Persisted window bounds: (x, y, width, height) or None for defaults.
    bounds: Mutex<Option<(i32, i32, u32, u32)>>,
}

fn bounds_file<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("frontend_bounds.json"))
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
        let _ = std::fs::write(path, serde_json::to_string_pretty(&json).unwrap_or_default());
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
    let usable_width = area.size.width.saturating_sub((RESTORE_MARGIN * 2) as u32).max(1);
    let usable_height = area.size.height.saturating_sub((RESTORE_MARGIN * 2) as u32).max(1);
    let width = w.clamp(DEFAULT_WIDTH.min(usable_width), usable_width);
    let height = h.clamp(DEFAULT_HEIGHT.min(usable_height), usable_height);
    let min_x = area.position.x.saturating_add(RESTORE_MARGIN);
    let min_y = area.position.y.saturating_add(RESTORE_MARGIN);
    let max_x = area.position.x
        .saturating_add(area.size.width.min(i32::MAX as u32) as i32)
        .saturating_sub(width.min(i32::MAX as u32) as i32)
        .saturating_sub(RESTORE_MARGIN)
        .max(min_x);
    let max_y = area.position.y
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

    let mut builder = WebviewWindowBuilder::new(&app, FRONTEND_LABEL, WebviewUrl::External(url))
        .title(FRONTEND_TITLE)
        .inner_size(DEFAULT_WIDTH as f64, DEFAULT_HEIGHT as f64)
        .min_inner_size(800.0, 600.0)
        // The frontend renders the title bar and window controls so it can
        // inherit the active Lumiverse theme on every desktop platform.
        .decorations(false)
        // Frameless windows do not receive a platform shadow by default on
        // every backend. Enabling it here lets the compositor derive the
        // window outline from the transparent, CSS-clipped document surface.
        .shadow(true)
        // The tray host starts without a Dock/taskbar entry. Enable the
        // frontend's entry immediately before its first show below.
        .skip_taskbar(true)
        // The frontend owns its own surface color. Keeping the native window
        // and WebView transparent lets a theme opt into a translucent body.
        // Opaque themes remain visually identical because their CSS body/app
        // surfaces cover the transparent host.
        .transparent(true)
        .background_color(tauri::webview::Color(0, 0, 0, 0))
        .visible(false);

    // Use the high-refresh WebView configuration where macOS supports it. The
    // frontend supplies dragging and window controls for this frameless shell.
    #[cfg(target_os = "macos")]
    {
        if let Some(configuration) = high_refresh_webview_configuration() {
            builder = builder.with_webview_configuration(configuration);
        }
    }

    let saved_bounds = state.bounds.lock().unwrap().clone().or_else(|| load_bounds(&app));
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
    window.set_shadow(true).map_err(|e| e.to_string())?;
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
pub fn hide_frontend(
    app: AppHandle,
    state: State<'_, FrontendState>,
) -> Result<(), String> {
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

    // The argument is macOS-specific below, but must stay accepted on every
    // supported target so the frontend can use one command shape.
    let _ = &blur_intensity;

    let window = app
        .get_webview_window(FRONTEND_LABEL)
        .ok_or("Frontend is not open")?;

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
        let material = blur.then(|| match blur_intensity.as_deref() {
            Some("subtle") => NSVisualEffectMaterial::WindowBackground,
            Some("strong") => NSVisualEffectMaterial::HudWindow,
            _ => NSVisualEffectMaterial::Sidebar,
        });
        let window_for_effect = window.clone();

        window.run_on_main_thread(move || {
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
            window.set_effects(None).map_err(|error| error.to_string())?;
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, blur, dark);
    }

    Ok(())
}

/// Show the small native settings window used to configure a cloud frontend.
#[tauri::command]
pub fn show_frontend_url_settings(app: AppHandle) -> Result<(), String> {
    const LABEL: &str = "frontend-url-settings";
    if let Some(window) = app.get_webview_window(LABEL) {
        window.show().map_err(|e| e.to_string())?;
        return window.set_focus().map_err(|e| e.to_string());
    }

    let window = WebviewWindowBuilder::new(
        &app,
        LABEL,
        WebviewUrl::App("custom-url.html".into()),
    )
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
