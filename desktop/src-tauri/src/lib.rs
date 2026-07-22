mod frontend;
mod runner;

use tauri_plugin_autostart::MacosLauncher;

/// `tauri dev` can launch a raw executable instead of a bundled `.app`, which
/// has no Info.plist icon for the Dock to read. Set the same bundled icon on
/// NSApplication directly so debug and packaged launches look identical.
#[cfg(target_os = "macos")]
fn set_macos_app_icon() {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;

    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let icon_data = NSData::with_bytes(include_bytes!("../icons/icon.png"));
    let Some(icon) = NSImage::initWithData(NSImage::alloc(), &icon_data) else {
        return;
    };
    let app = NSApplication::sharedApplication(main_thread);
    unsafe { app.setApplicationIconImage(Some(&icon)) };
}

#[cfg(target_os = "macos")]
fn macos_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let about = PredefinedMenuItem::about(app, Some("About Lumiverse"), None)?;
    let first_separator = PredefinedMenuItem::separator(app)?;
    let second_separator = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, Some("Hide Lumiverse"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let quit = MenuItem::with_id(app, "app.quit", "Quit Lumiverse", true, Some("CmdOrCtrl+Q"))?;
    let app_menu = Submenu::with_items(
        app,
        "Lumiverse",
        true,
        &[
            &about,
            &first_separator,
            &hide,
            &hide_others,
            &show_all,
            &second_separator,
            &quit,
        ],
    )?;

    let reload = MenuItem::with_id(
        app,
        "frontend.reload",
        "Reload Frontend",
        true,
        Some("CmdOrCtrl+R"),
    )?;
    let hide_frontend = MenuItem::with_id(
        app,
        "frontend.hide",
        "Hide Frontend",
        true,
        Some("CmdOrCtrl+W"),
    )?;
    // Web Inspector is intentionally a debug-build tool: Tauri's macOS
    // implementation uses a private WebKit API and is unavailable in normal
    // release builds. Keep an explicit menu entry so reopening the frontend
    // or reloading it does not require restarting the app to inspect it.
    #[cfg(debug_assertions)]
    let frontend_menu = {
        let inspect = MenuItem::with_id(
            app,
            "frontend.devtools",
            "Open Web Inspector",
            true,
            Some("CmdOrCtrl+Alt+I"),
        )?;
        Submenu::with_items(app, "Frontend", true, &[&reload, &hide_frontend, &inspect])?
    };
    #[cfg(not(debug_assertions))]
    let frontend_menu = Submenu::with_items(
        app,
        "Frontend",
        true,
        &[&reload, &hide_frontend],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let maximize = PredefinedMenuItem::maximize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[&minimize, &maximize, &fullscreen],
    )?;

    Menu::with_items(app, &[&app_menu, &frontend_menu, &window_menu])
}

#[cfg(target_os = "macos")]
fn handle_macos_menu_event<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    event: tauri::menu::MenuEvent,
) {
    use tauri::Manager;
    match event.id().as_ref() {
        "frontend.reload" => {
            if let Some(window) = app.get_webview_window("frontend") {
                let _ = frontend::set_frontend_task_switcher_visible(app, &window, true);
                let _ = app.show();
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.reload();
            }
        }
        "frontend.hide" => {
            frontend::hide_frontend_window(app);
        }
        #[cfg(debug_assertions)]
        "frontend.devtools" => {
            if let Some(window) = app.get_webview_window("frontend") {
                window.open_devtools();
            }
        }
        "app.quit" => {
            runner::force_stop(app);
            app.exit(0);
        }
        _ => {}
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(runner::RunnerState::default())
        .manage(frontend::FrontendState::default())
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
            frontend::show_frontend,
            frontend::hide_frontend,
            frontend::reload_frontend,
            frontend::save_frontend_bounds,
            frontend::frontend_visible,
            frontend::frontend_exists,
            frontend::configure_frontend_appearance,
            frontend::show_frontend_url_settings,
        ]);

    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu).on_menu_event(handle_macos_menu_event);

    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            set_macos_app_icon();
            // Keep normal macOS application/menu integration; the frontend
            // lifecycle independently controls only Dock visibility.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            #[cfg(target_os = "macos")]
            app.set_dock_visibility(false);
            let _ = app;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Lumiverse");
}
