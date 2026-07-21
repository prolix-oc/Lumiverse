mod dashboard;
mod runner;

use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(runner::RunnerState::default())
        .manage(dashboard::DashboardState::default())
        .invoke_handler(tauri::generate_handler![
            runner::runner_start,
            runner::runner_send,
            runner::runner_alive,
            runner::runner_kill,
            runner::validate_repo,
            runner::discover_repo,
            runner::resolve_bun,
            runner::quit_app,
            runner::alert,
            runner::pick_folder,
            dashboard::show_dashboard,
            dashboard::hide_dashboard,
            dashboard::save_dashboard_bounds,
            dashboard::dashboard_visible,
        ])
        .setup(|app| {
            // Menu-bar-only app: no Dock icon on macOS.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lumiverse Tray");
}
