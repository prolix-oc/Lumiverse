mod bundled_server;
mod capture;
mod data_folder;
mod desktop_updates;
mod desktop_surface;
mod discord_rpc;
mod external_launch;
mod frontend;
mod host_environment;
mod keybindings;
mod linux_runtime;
mod linux_smoke;
mod notifications;
mod profile;
#[cfg(test)]
#[path = "../release_config.rs"]
mod release_config;
mod remote_instance;
mod runner;
mod system_audio;
mod tls;
#[cfg(target_os = "linux")]
mod wayland_background_effect;
#[cfg(any(target_os = "linux", test))]
mod webview_media;
#[cfg(any(target_os = "windows", test))]
mod webview_visibility;

use tauri::Manager;
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
        "Close Window",
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
    let frontend_menu = Submenu::with_items(app, "Frontend", true, &[&reload, &hide_frontend])?;

    // macOS routes the clipboard shortcuts through the Edit menu's standard
    // items rather than delivering them to the focused view directly. Without
    // this submenu, Cmd+C/V/X/A/Z do nothing anywhere in the app — and because
    // the frontend window is built with decorations(false), there is no native
    // chrome offering them either. The WebView's own context menu still works,
    // which is why this reads as "only the keyboard is broken".
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let edit_separator = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &edit_separator,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let maximize = PredefinedMenuItem::maximize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let window_menu =
        Submenu::with_items(app, "Window", true, &[&minimize, &maximize, &fullscreen])?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &frontend_menu, &window_menu])
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
                frontend::emit_frontend_presence(app, &window);
                let _ = window.reload();
            }
        }
        "frontend.hide" => {
            if !frontend::close_focused_popup(app) {
                frontend::hide_frontend_window(app);
            }
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
    tls::initialize_provider();
    let mut context = tauri::generate_context!();
    let profile = profile::prepare(context.config_mut(), std::env::args().skip(1))
        .expect("invalid desktop profile arguments");
    #[cfg(target_os = "linux")]
    {
        linux_runtime::configure(&profile.identifier);
        if linux_runtime::opaque() {
            for window in &mut context.config_mut().app.windows {
                window.transparent = false;
            }
        }
    }
    let remote_state = remote_instance::RemoteInstanceState::for_identifier(&profile.identifier);
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(!cfg!(target_os = "linux"))
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(runner::RunnerState::default())
        .manage(bundled_server::BundledServerState::default())
        .manage(desktop_updates::DesktopUpdatesState::default())
        .manage(runner::DesktopUpdateResumeState::default())
        .manage(frontend::FrontendState::default())
        .manage(frontend::DesktopWidgetCatalogState::default())
        .manage(notifications::DesktopNotificationTransportState::default())
        .manage(remote_state)
        .manage(profile)
        .manage(discord_rpc::DiscordRpcState::default())
        .manage(capture::DesktopCaptureState::default())
        .manage(keybindings::KeybindingsState::default())
        .manage(system_audio::SystemAudioState::default())
        .on_page_load(|webview, payload| {
            // A reloaded or navigated frontend can no longer receive frames from a session its old page started.
            if webview.label() == "frontend"
                && matches!(payload.event(), tauri::webview::PageLoadEvent::Started)
            {
                system_audio::frontend_gone(webview.app_handle());
                keybindings::frontend_gone(webview.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            keybindings::desktop_keybindings_show,
            keybindings::desktop_keybindings_get,
            keybindings::desktop_keybindings_save,
            keybindings::desktop_keybindings_publish,
            keybindings::desktop_keybindings_trigger,
            keybindings::desktop_keybindings_frontend_get,
            keybindings::desktop_keybindings_frontend_save,
            keybindings::desktop_keybindings_global_permission,
            keybindings::desktop_keybindings_editing,
            profile::desktop_profile_info,
            external_launch::open_external_url,
            external_launch::reveal_desktop_artifact,
            linux_runtime::linux_diagnostics,
            linux_runtime::save_linux_graphics,
            linux_runtime::show_linux_settings,
            linux_smoke::desktop_smoke_complete,
            remote_instance::remote_authorization_status,
            remote_instance::remote_authorization_cancel,
            remote_instance::remote_authorization_retry,
            data_folder::open_lumiverse_data_folder,
            desktop_updates::desktop_update_info,
            desktop_updates::desktop_update_check,
            desktop_updates::desktop_update_download,
            desktop_updates::desktop_update_install,
            bundled_server::bundled_server_available,
            bundled_server::bundled_server_start,
            bundled_server::bundled_server_stop,
            bundled_server::bundled_server_status,
            bundled_server::bundled_server_alive,
            bundled_server::bundled_server_network_access,
            bundled_server::bundled_server_set_network_access,
            bundled_server::bundled_setup_defaults,
            bundled_server::bundled_setup_save,
            bundled_server::bundled_setup_status,
            bundled_server::bundled_setup_complete,
            bundled_server::bundled_setup_pick_folder,
            runner::runner_start,
            runner::runner_send,
            runner::runner_alive,
            runner::runner_kill,
            runner::validate_repo,
            runner::discover_repo,
            runner::resolve_bun,
            runner::desktop_shell_sha,
            runner::stage_desktop_update,
            runner::take_desktop_update_resume,
            frontend::desktop_startup_ready,
            frontend::close_current_sso_popup,
            runner::quit_app,
            runner::alert,
            runner::confirm,
            runner::pick_folder,
            frontend::show_frontend,
            frontend::close_frontend,
            frontend::reload_frontend,
            frontend::save_frontend_bounds,
            frontend::frontend_visible,
            frontend::frontend_presence,
            frontend::frontend_exists,
            frontend::configure_frontend_appearance,
            frontend::cache_frontend_startup_appearance,
            frontend::show_frontend_url_settings,
            frontend::set_desktop_widget_catalog,
            frontend::sync_desktop_widget_size,
            frontend::resize_extension_widget,
            frontend::show_extension_widget,
            frontend::return_extension_widget,
            frontend::return_extension_widget_from_tray,
            notifications::desktop_notification_device,
            notifications::desktop_notification_permission,
            notifications::desktop_notification_transport_status,
            notifications::save_desktop_notification_enrollment,
            notifications::clear_desktop_notification_enrollment,
            remote_instance::remote_instance_connect,
            remote_instance::remote_instance_poll,
            remote_instance::remote_instance_disconnect,
            remote_instance::discord_presence_fetch,
            discord_rpc::discord_rpc_set_enabled,
            discord_rpc::discord_rpc_update,
            discord_rpc::discord_presence_changed,
            capture::desktop_capture_connect,
            capture::desktop_capture_disconnect,
            capture::desktop_capture_status,
            capture::desktop_capture_request_setup,
            capture::desktop_capture_setup_finished,
            capture::desktop_capture_reset_approvals,
            system_audio::desktop_system_audio_status,
            system_audio::desktop_system_audio_set_enabled,
            system_audio::desktop_system_audio_start,
            system_audio::desktop_system_audio_stop,
        ]);

    #[cfg(target_os = "linux")]
    let builder = builder.plugin(
        tauri::plugin::Builder::<tauri::Wry>::new("linux-runtime")
            .js_init_script(include_str!("external-links.js"))
            .on_webview_ready(|webview| linux_runtime::observe(&webview))
            .build(),
    );

    #[cfg(target_os = "windows")]
    let builder = builder.plugin(webview_visibility::init());

    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos_menu)
        .on_menu_event(handle_macos_menu_event);

    builder
        .setup(|app| {
            profile::initialize(app.handle())?;
            desktop_updates::restore_resume(app.handle())?;
            if let Err(error) = app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_handler(|app, shortcut, event| {
                        keybindings::global_event(app, shortcut, event.state());
                    })
                    .build(),
            ) {
                eprintln!("[keybindings] Global shortcuts unavailable: {error}");
            }
            if let Err(error) = keybindings::initialize(app.handle()) {
                eprintln!("[keybindings] Could not restore shortcuts: {error}");
            }
            #[cfg(target_os = "macos")]
            set_macos_app_icon();
            // Keep normal macOS application/menu integration; the frontend
            // lifecycle independently controls only Dock visibility.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);
            #[cfg(target_os = "macos")]
            app.set_dock_visibility(false);
            if let Err(error) = notifications::restart_desktop_notification_transport(app.handle())
            {
                eprintln!("[desktop-notification] startup failed: {error}");
            }
            Ok(())
        })
        .build(context)
        .expect("error while building Lumiverse")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                capture::shutdown(app);
                // Cover native exit paths on every platform, including ones
                // that never passed through the tray's JS quit handshake.
                notifications::stop_desktop_notification_transport(app);
                discord_rpc::shutdown(&tauri::Manager::state::<discord_rpc::DiscordRpcState>(app));
                runner::force_stop(app);
            }
        });
}
