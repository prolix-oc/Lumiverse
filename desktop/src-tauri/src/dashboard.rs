//! Dashboard window — frameless webview that wraps the Lumiverse frontend.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

const DASHBOARD_LABEL: &str = "dashboard";
const DASHBOARD_TITLE: &str = "Lumiverse";

#[derive(Default)]
pub struct DashboardState {
    /// Persisted window bounds: (x, y, width, height) or None for defaults.
    bounds: Mutex<Option<(i32, i32, u32, u32)>>,
}

fn bounds_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("dashboard_bounds.json"))
}

fn load_bounds(app: &AppHandle) -> Option<(i32, i32, u32, u32)> {
    let file = bounds_file(app)?;
    let data = std::fs::read_to_string(file).ok()?;
    let v: serde_json::Value = serde_json::from_str(&data).ok()?;
    Some((
        v.get("x")?.as_i64()? as i32,
        v.get("y")?.as_i64()? as i32,
        v.get("width")?.as_u64()? as u32,
        v.get("height")?.as_u64()? as u32,
    ))
}

fn save_bounds_to_file(app: &AppHandle, x: i32, y: i32, w: u32, h: u32) {
    if let Some(path) = bounds_file(app) {
        let json = serde_json::json!({ "x": x, "y": y, "width": w, "height": h });
        let _ = std::fs::write(path, serde_json::to_string_pretty(&json).unwrap_or_default());
    }
}

#[tauri::command]
pub fn show_dashboard(
    app: AppHandle,
    port: u16,
    state: State<'_, DashboardState>,
) -> Result<(), String> {
    let url = WebviewUrl::App(format!("src/dashboard.html?port={port}").into());

    // If the window already exists, just show it.
    if let Some(window) = app.get_webview_window(DASHBOARD_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    let mut builder = WebviewWindowBuilder::new(&app, DASHBOARD_LABEL, url)
        .title(DASHBOARD_TITLE)
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .decorations(false)
        .visible(true);

    // Restore persisted bounds if available.
    let bounds = state.bounds.lock().unwrap().clone();
    if let Some((x, y, w, h)) = bounds {
        builder = builder
            .position(x as f64, y as f64)
            .inner_size(w as f64, h as f64);
    } else if let Some((x, y, w, h)) = load_bounds(&app) {
        builder = builder
            .position(x as f64, y as f64)
            .inner_size(w as f64, h as f64);
        *state.bounds.lock().unwrap() = Some((x, y, w, h));
    } else {
        builder = builder.center();
    }

    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn hide_dashboard(
    app: AppHandle,
    state: State<'_, DashboardState>,
) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(DASHBOARD_LABEL) {
        // Persist bounds before hiding.
        if let (Ok(pos), Ok(size)) = (window.inner_position(), window.inner_size()) {
            let bounds = (pos.x, pos.y, size.width, size.height);
            *state.bounds.lock().unwrap() = Some(bounds);
            save_bounds_to_file(&app, bounds.0, bounds.1, bounds.2, bounds.3);
        }
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn save_dashboard_bounds(
    app: AppHandle,
    state: State<'_, DashboardState>,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) {
    *state.bounds.lock().unwrap() = Some((x, y, width, height));
    save_bounds_to_file(&app, x, y, width, height);
}

#[tauri::command]
pub fn dashboard_visible(app: AppHandle) -> bool {
    app.get_webview_window(DASHBOARD_LABEL)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false)
}
