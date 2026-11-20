//! Graphics policy is deliberately reversible. No GPU is inferred from loaded
//! kernel modules, and no NVIDIA workaround is selected without hardware evidence.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use crate::host_environment::{original_value, Environment};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicsSettings {
    pub backend: String,
    pub mode: String,
    pub opaque: bool,
}
static ACTIVE: OnceLock<GraphicsSettings> = OnceLock::new();
static SETTINGS_PATH: OnceLock<PathBuf> = OnceLock::new();
static STARTUP: OnceLock<String> = OnceLock::new();
static EVENTS: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn select_backend(env: &Environment, saved: &str) -> (Option<OsString>, &'static str) {
    let populated = |value: Option<OsString>| value.filter(|value| !value.is_empty());
    if let Some(value) = populated(env.get(OsStr::new("LUMIVERSE_GDK_BACKEND")).cloned()) {
        return (Some(value), "user: LUMIVERSE_GDK_BACKEND");
    }
    if let Some(value) = populated(original_value(env, "GDK_BACKEND")) {
        return (Some(value), "user: original GDK_BACKEND");
    }
    // Keep XWayland as the default until the accelerated native-Wayland
    // hardware matrix is qualified. Pure Wayland must still be able to start.
    let has = |key: &str| {
        env.get(OsStr::new(key))
            .is_some_and(|value| !value.is_empty())
    };
    if (saved == "wayland" && has("WAYLAND_DISPLAY")) || (saved == "x11" && has("DISPLAY")) {
        return (Some(saved.into()), "saved graphics choice");
    }
    if has("WAYLAND_DISPLAY") && !has("DISPLAY") {
        return (Some("wayland".into()), "automatic: pure Wayland session");
    }
    (None, "automatic: GTK/AppRun default (X11 when available)")
}

fn valid(settings: &GraphicsSettings) -> bool {
    matches!(settings.backend.as_str(), "" | "auto" | "wayland" | "x11")
        && matches!(
            settings.mode.as_str(),
            "" | "default" | "accelerated" | "nvidia-sync" | "dmabuf-off" | "software"
        )
}

pub fn configure(identifier: &str) {
    crate::host_environment::capture();
    let env: Environment = std::env::vars_os().collect();
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|p| PathBuf::from(p).is_absolute())
        .or_else(|| {
            std::env::var_os("HOME")
                .map(|home| PathBuf::from(home).join(".config").into_os_string())
        });
    let path = base.map(|base| {
        PathBuf::from(base)
            .join(identifier)
            .join("linux-graphics.json")
    });
    let settings: GraphicsSettings = path
        .as_ref()
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(valid)
        .unwrap_or_default();
    if let Some(path) = path {
        let _ = SETTINGS_PATH.set(path);
    }
    let (backend, source) = select_backend(&env, &settings.backend);
    if let Some(backend) = backend {
        std::env::set_var("GDK_BACKEND", backend);
    }
    record(format!(
        "requested GDK backend: {}; source: {source}",
        safe_value(std::env::var("GDK_BACKEND").ok().as_deref())
    ));
    // Explicit environment values always win over a saved compatibility mode.
    let overrides = mode_overrides(&settings.mode);
    for (key, value) in &overrides {
        if std::env::var_os(key).is_none() {
            std::env::set_var(key, value);
        }
    }
    for key in [
        "__NV_DISABLE_EXPLICIT_SYNC",
        "WEBKIT_DISABLE_DMABUF_RENDERER",
        "WEBKIT_DISABLE_COMPOSITING_MODE",
        "LIBGL_ALWAYS_SOFTWARE",
        "GALLIUM_DRIVER",
        "LUMIVERSE_LINUX_OPAQUE",
    ] {
        let source = if env.contains_key(OsStr::new(key)) {
            if original_value(&env, key).is_some() {
                "user launch environment"
            } else {
                "AppRun/launcher environment"
            }
        } else if overrides.iter().any(|(name, _)| *name == key) {
            "saved graphics choice"
        } else {
            "default"
        };
        record(format!(
            "{key}={}; source: {source}",
            safe_value(std::env::var(key).ok().as_deref()),
        ));
    }
    record("NVIDIA automatic workaround: disabled pending accelerated hardware qualification (including hybrid GPUs)".into());
    let _ = ACTIVE.set(settings);
    record(format!(
        "opaque windows at creation: {}; source: {}",
        opaque(),
        if env.contains_key(OsStr::new("LUMIVERSE_LINUX_OPAQUE")) {
            "user launch environment"
        } else {
            "saved graphics choice/default"
        }
    ));
    let mut events = EVENTS.lock().unwrap();
    let _ = STARTUP.set(events.join("\n"));
    events.clear();
}

fn mode_overrides(mode: &str) -> Vec<(&'static str, &'static str)> {
    match mode {
        // WebKitGTK 2.50 checks these disable flags against "0" explicitly.
        // This requests its accelerated path; it does not prove GPU rendering.
        "accelerated" => vec![
            ("WEBKIT_DISABLE_DMABUF_RENDERER", "0"),
            ("WEBKIT_DISABLE_COMPOSITING_MODE", "0"),
        ],
        "nvidia-sync" => vec![("__NV_DISABLE_EXPLICIT_SYNC", "1")],
        "dmabuf-off" => vec![("WEBKIT_DISABLE_DMABUF_RENDERER", "1")],
        "software" => vec![("WEBKIT_DISABLE_COMPOSITING_MODE", "1")],
        _ => vec![],
    }
}
fn safe_value(value: Option<&str>) -> String {
    value
        .map(|v| {
            v.chars()
                .filter(|c| c.is_ascii_alphanumeric() || ",_-.:".contains(*c))
                .take(100)
                .collect()
        })
        .unwrap_or_else(|| "unset".into())
}
pub fn opaque() -> bool {
    cfg!(target_os = "linux")
        && std::env::var("LUMIVERSE_LINUX_OPAQUE")
            .map(|v| v == "1")
            .unwrap_or_else(|_| ACTIVE.get().is_some_and(|s| s.opaque))
}
pub fn record(message: String) {
    eprintln!("[linux-runtime] {message}");
    let mut events = EVENTS.lock().unwrap();
    if events.len() == 64 {
        events.remove(0);
    }
    events.push(message);
}

#[cfg(target_os = "linux")]
pub fn observe(webview: &tauri::Webview) {
    use gtk::prelude::*;
    use webkit2gtk::WebViewExt;
    let label = webview.label().to_owned();
    let _ = webview.with_webview(move |platform| {
        let view = platform.inner();
        let display = gtk::prelude::WidgetExt::display(&view);
        record(format!(
            "window={label}; actual GDK display type={}; GTK={}.{}.{}; WebKitGTK={}.{}.{}",
            display.type_().name(),
            gtk::major_version(),
            gtk::minor_version(),
            gtk::micro_version(),
            unsafe { webkit2gtk::ffi::webkit_get_major_version() },
            unsafe { webkit2gtk::ffi::webkit_get_minor_version() },
            unsafe { webkit2gtk::ffi::webkit_get_micro_version() }
        ));
        view.connect_web_process_terminated(move |_, reason| {
            record(format!(
                "window={label}; WebKit process terminated: {reason:?}"
            ))
        });
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostics {
    settings: GraphicsSettings,
    report: String,
}
#[tauri::command]
pub fn linux_diagnostics(window: tauri::WebviewWindow) -> Result<Diagnostics, String> {
    if !matches!(window.label(), "main" | "linux-settings") {
        return Err("Diagnostics belong to the local desktop controls.".into());
    }
    let mut report = format!(
        "Lumiverse Desktop {}\nrevision={}\ntarget={}\n",
        env!("CARGO_PKG_VERSION"),
        env!("LUMIVERSE_DESKTOP_SHA"),
        env!("LUMIVERSE_DESKTOP_TARGET")
    );
    report.push_str(
        STARTUP
            .get()
            .map(String::as_str)
            .unwrap_or("Linux startup policy was not initialized."),
    );
    report.push('\n');
    report.push_str(&EVENTS.lock().unwrap().join("\n"));
    #[cfg(target_os = "linux")]
    {
        // No full environment, hostnames, browser URLs, or OAuth material.
        // Paths are reduced to library names plus bundle/host classification.
        if let Ok(maps) = std::fs::read_to_string("/proc/self/maps") {
            let mut libraries = std::collections::BTreeSet::new();
            let appdir = std::env::var("APPDIR").unwrap_or_default();
            for line in maps.lines() {
                if let Some(index) = line.find('/') {
                    let path = &line[index..];
                    if [
                        "libwebkit",
                        "libjavascriptcore",
                        "libgtk",
                        "libglib",
                        "libgio",
                        "libsoup",
                        "libgst",
                        "libwayland",
                        "libEGL",
                        "libGL",
                        "libnvidia",
                    ]
                    .iter()
                    .any(|needle| path.contains(needle))
                    {
                        libraries.insert(format!(
                            "{} ({})",
                            std::path::Path::new(path)
                                .file_name()
                                .unwrap_or_default()
                                .to_string_lossy(),
                            if !appdir.is_empty() && path.starts_with(&appdir) {
                                "bundle"
                            } else {
                                "host"
                            }
                        ));
                    }
                }
            }
            report.push_str("\nUI process loaded libraries:\n");
            report.push_str(&libraries.into_iter().collect::<Vec<_>>().join("\n"));
        }
        if let Some(appdir) = std::env::var_os("APPDIR") {
            if let Ok(manifest) = std::fs::read_to_string(
                PathBuf::from(appdir).join("usr/share/lumiverse/runtime-manifest.json"),
            ) {
                report.push('\n');
                report.push_str(&manifest);
            }
        }
    }
    report.push_str("\nAcceleration is not inferred from a WebGL context or session hints. Qualify the renderer and WebKit helper processes on the target hardware.\n");
    Ok(Diagnostics {
        settings: ACTIVE.get().cloned().unwrap_or_default(),
        report,
    })
}

#[tauri::command]
pub fn save_linux_graphics(
    window: tauri::WebviewWindow,
    settings: GraphicsSettings,
) -> Result<(), String> {
    if window.label() != "linux-settings" || !cfg!(target_os = "linux") || !valid(&settings) {
        return Err("Invalid Linux graphics settings.".into());
    }
    let path = SETTINGS_PATH
        .get()
        .ok_or("No configuration directory available")?;
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let staging = path.with_extension("json.tmp");
    std::fs::write(&staging, serde_json::to_vec_pretty(&settings).unwrap())
        .map_err(|e| e.to_string())?;
    std::fs::rename(staging, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn show_linux_settings(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    use tauri::Manager;
    if window.label() != "main" || !cfg!(target_os = "linux") {
        return Err("Linux graphics settings belong to the tray.".into());
    }
    if let Some(window) = app.get_webview_window("linux-settings") {
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "linux-settings",
        tauri::WebviewUrl::App("linux-settings.html".into()),
    )
    .title("Linux Graphics & Diagnostics")
    .inner_size(620.0, 620.0)
    .min_inner_size(320.0, 240.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(values: &[(&str, &str)]) -> Environment {
        values
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }
    #[test]
    fn explicit_backend_and_original_lists_survive_apprun() {
        let input = env(&[
            ("LUMIVERSE_HOST_ENV_CAPTURED", "1"),
            ("LUMIVERSE_HOST_GDK_BACKEND_SET", "1"),
            ("LUMIVERSE_HOST_GDK_BACKEND", "wayland,x11"),
            ("GDK_BACKEND", "x11"),
        ]);
        assert_eq!(select_backend(&input, "x11").0.unwrap(), "wayland,x11");
        let mut input = input;
        input.insert("LUMIVERSE_GDK_BACKEND".into(), "x11".into());
        assert_eq!(select_backend(&input, "wayland").0.unwrap(), "x11");
    }
    #[test]
    fn avoids_unqualified_gpu_policy_and_handles_unset_capture() {
        let input = env(&[
            ("LUMIVERSE_HOST_ENV_CAPTURED", "1"),
            ("GDK_BACKEND", "x11"),
            ("WAYLAND_DISPLAY", "wayland-0"),
        ]);
        assert_eq!(select_backend(&input, "auto").0.unwrap(), "wayland");
        let mut input = input;
        input.insert("DISPLAY".into(), ":0".into());
        assert_eq!(select_backend(&input, "auto").0, None);
        assert_eq!(select_backend(&input, "wayland").0.unwrap(), "wayland");
        let pure_wayland = env(&[("WAYLAND_DISPLAY", "wayland-0")]);
        assert_eq!(select_backend(&pure_wayland, "x11").0.unwrap(), "wayland");
        let x11 = env(&[("DISPLAY", ":0")]);
        assert_eq!(select_backend(&x11, "wayland").0, None);
        assert!(mode_overrides("default").is_empty());
        assert_eq!(
            mode_overrides("nvidia-sync"),
            vec![("__NV_DISABLE_EXPLICIT_SYNC", "1")]
        );
    }
}
