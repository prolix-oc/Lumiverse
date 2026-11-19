//! Owns the packaged server. Configuration crosses private stdio, never HTTP.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{self, BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

const SETUP_WINDOW: &str = "server-setup";

/// Native dependencies can write Windows code-page bytes and progress text
/// without a newline. Neither may prevent subsequent private frames arriving.
fn read_output(
    reader: impl io::Read,
    mut frame: impl FnMut(&str) -> bool,
    mut log: impl FnMut(&str),
) -> io::Result<()> {
    let mut reader = BufReader::new(reader);
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        if reader.read_until(b'\n', &mut bytes)? == 0 {
            return Ok(());
        }
        let line = String::from_utf8_lossy(&bytes);
        let line = line.trim_end_matches(['\r', '\n']);
        let mut parts = line.split('\u{1e}');
        if let Some(text) = parts.next().filter(|text| !text.is_empty()) {
            log(text);
        }
        for part in parts {
            if !frame(part) {
                log(part);
            }
        }
    }
}

type Reply = Result<Value, String>;
struct Running {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    token: String,
}
#[derive(Default)]
pub struct BundledServerState {
    running: Mutex<Option<Running>>,
    status: Mutex<Value>,
    pending: Mutex<HashMap<String, oneshot::Sender<Reply>>>,
}

pub(crate) fn binary() -> Option<PathBuf> {
    let name = if cfg!(windows) {
        "lumiverse-server.exe"
    } else {
        "lumiverse-server"
    };
    let installed = std::env::current_exe().ok()?.parent()?.join(name);
    if installed.is_file() {
        return Some(installed);
    }
    #[cfg(debug_assertions)]
    {
        let extension = if cfg!(windows) { ".exe" } else { "" };
        let staged = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(format!(
                "lumiverse-server-{}{extension}",
                env!("LUMIVERSE_DESKTOP_TARGET")
            ));
        if staged.is_file() {
            return Some(staged);
        }
    }
    None
}
fn require_window(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() == label {
        Ok(())
    } else {
        Err("This command belongs to a different desktop window.".into())
    }
}
fn enqueue(
    state: &BundledServerState,
    verb: &str,
    payload: Value,
) -> Result<oneshot::Receiver<Reply>, String> {
    let mut running = state.running.lock().unwrap();
    let running = running
        .as_mut()
        .ok_or("The bundled server is not running.")?;
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id.clone(), tx);
    let line = json!({ "id": id, "type": verb, "payload": payload });
    if let Err(error) = writeln!(running.stdin, "{line}").and_then(|_| running.stdin.flush()) {
        state.pending.lock().unwrap().remove(&id);
        return Err(format!("Server callback failed: {error}"));
    }
    Ok(rx)
}
async fn request(state: &BundledServerState, verb: &str, payload: Value) -> Reply {
    let rx = enqueue(state, verb, payload)?;
    tokio::time::timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| "The server callback timed out.".to_owned())?
        .map_err(|_| "The server exited before completing the callback.".to_owned())?
}
fn show_setup(app: AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(SETUP_WINDOW) {
        window.show()?;
        return window.set_focus();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_dock_visibility(true);
    }
    let window = crate::profile::configure_webview(WebviewWindowBuilder::new(
        &app,
        SETUP_WINDOW,
        WebviewUrl::App("server-setup.html".into()),
    ))
    .title("Set up Lumiverse")
    .inner_size(680.0, 760.0)
    .min_inner_size(480.0, 620.0)
    .center()
    .build()?;
    let owner = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
            let state = owner.state::<BundledServerState>();
            if state
                .status
                .lock()
                .unwrap()
                .get("state")
                .and_then(Value::as_str)
                != Some("running")
            {
                let _ = enqueue(&state, "shutdown", Value::Null);
            }
        }
    });
    Ok(())
}
fn handle_frame(app: &AppHandle, token: &str, text: &str) -> bool {
    let Ok(frame) = serde_json::from_str::<Value>(text) else {
        return false;
    };
    if frame.get("token").and_then(Value::as_str) != Some(token) {
        return false;
    }
    let state = app.state::<BundledServerState>();
    match frame.get("type").and_then(Value::as_str) {
        Some("response") => {
            if let Some(id) = frame.get("id").and_then(Value::as_str) {
                if let Some(reply) = state.pending.lock().unwrap().remove(id) {
                    let result = if frame.get("success") == Some(&Value::Bool(true)) {
                        Ok(frame.get("data").cloned().unwrap_or(Value::Null))
                    } else {
                        Err(frame
                            .get("error")
                            .and_then(Value::as_str)
                            .unwrap_or("Server callback failed.")
                            .to_owned())
                    };
                    let _ = reply.send(result);
                }
            }
        }
        Some("status") => {
            if let Some(status) = frame.get("status") {
                *state.status.lock().unwrap() = status.clone();
                let _ = app.emit_to("main", "bundled-server-status", status);
                if let Some(error) = status.get("error").and_then(Value::as_str) {
                    let _ = app.emit_to("main", "bundled-server-error", error);
                }
            }
        }
        Some("setup") => {
            let handle = app.clone();
            let open = move || {
                if let Err(error) = show_setup(handle.clone()) {
                    let message = format!("Could not open server setup: {error}");
                    eprintln!("{message}");
                    let _ = handle.emit_to("main", "bundled-server-error", message);
                }
            };
            // WebView2 creation can deadlock inside a Windows event callback.
            // Keep the pipe reader free for setup replies while a worker opens
            // the window. WebKit on macOS still needs the main thread.
            #[cfg(windows)]
            tauri::async_runtime::spawn_blocking(open);
            #[cfg(not(windows))]
            if let Err(error) = app.run_on_main_thread(open) {
                let message = format!("Could not schedule server setup: {error}");
                eprintln!("{message}");
                let _ = app.emit_to("main", "bundled-server-error", message);
            }
        }
        _ => return false,
    }
    true
}

#[tauri::command]
pub fn bundled_server_available(window: WebviewWindow) -> Result<bool, String> {
    if window.label() != "main" && window.label() != "frontend-url-settings" {
        return Err("Server availability belongs to the local instance selector.".into());
    }
    Ok(binary().is_some())
}
#[tauri::command]
pub fn bundled_server_status(window: WebviewWindow, state: State<'_, BundledServerState>) -> Reply {
    require_window(&window, "main")?;
    Ok(state.status.lock().unwrap().clone())
}
#[tauri::command]
pub fn bundled_server_alive(
    window: WebviewWindow,
    state: State<'_, BundledServerState>,
) -> Result<bool, String> {
    require_window(&window, "main")?;
    Ok(state.running.lock().unwrap().is_some())
}

async fn network_access(app: AppHandle, mode: &'static str) -> Reply {
    tauri::async_runtime::spawn_blocking(move || {
        let output = command(&app)?
            .args(["--network-access", mode])
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("Could not read or save network access: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
        }
        serde_json::from_slice(&output.stdout)
            .map_err(|error| format!("Invalid network access response: {error}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn bundled_server_network_access(app: AppHandle, window: WebviewWindow) -> Reply {
    require_window(&window, "main")?;
    network_access(app, "status").await
}

#[tauri::command]
pub async fn bundled_server_set_network_access(
    app: AppHandle,
    window: WebviewWindow,
    enabled: bool,
) -> Reply {
    require_window(&window, "main")?;
    network_access(app, if enabled { "on" } else { "off" }).await
}

/// Share the profile's path and environment overrides with read-only queries.
pub(crate) fn command(app: &AppHandle) -> Result<Command, String> {
    let executable = binary().ok_or("This desktop build does not include a server executable.")?;
    let mut command = Command::new(executable);
    // The server owns its runtime/native libraries; AppRun's GTK overrides
    // belong to the desktop and must not affect Bun or its subprocesses.
    #[cfg(target_os = "linux")]
    command
        .env_remove("LD_LIBRARY_PATH")
        .env_remove("LD_PRELOAD");
    if app.state::<crate::profile::DesktopProfile>().isolated {
        let root = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?
            .join("local-server");
        let config = root.join("config");
        command
            .arg("--config-dir")
            .arg(&config)
            .arg("--cache-dir")
            .arg(root.join("cache"));
        for key in [
            "DATA_DIR",
            "PORT",
            "LUMIVERSE_HOST",
            "OWNER_PASSWORD",
            "OWNER_USERNAME",
            "AUTH_SECRET",
            "ENCRYPTION_KEY",
        ] {
            command.env_remove(key);
        }
        if !config.join("server.json").is_file() {
            command
                .arg("--data-dir")
                .arg(root.join("data"))
                .arg("--port")
                .arg("17860");
        }
    }
    crate::runner::suppress_console(&mut command);
    Ok(command)
}

#[tauri::command]
pub fn bundled_server_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, BundledServerState>,
) -> Result<(), String> {
    require_window(&window, "main")?;
    let mut running = state.running.lock().unwrap();
    if running.is_some() {
        return Ok(());
    }
    let token = uuid::Uuid::new_v4().to_string();
    let mut command = command(&app)?;
    command
        .args(["--desktop", "--no-open"])
        .env("LUMIVERSE_DESKTOP_CHANNEL_TOKEN", &token)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    crate::runner::isolate_process_group(&mut command);
    let logs = Arc::new(Mutex::new(crate::runner::SessionLogs::new(&app)));
    logs.lock().unwrap().write_line(
        crate::runner::LogChannel::Stdout,
        &format!(
            "[desktop] Launching bundled server: {}",
            command.get_program().to_string_lossy()
        ),
    );
    if let Ok(directory) = std::env::current_dir() {
        logs.lock().unwrap().write_line(
            crate::runner::LogChannel::Stdout,
            &format!("[desktop] Working directory: {}", directory.display()),
        );
    }
    let mut child = command.spawn().map_err(|error| {
        let message = format!("Could not launch bundled server: {error}");
        logs.lock()
            .unwrap()
            .write_line(crate::runner::LogChannel::Stderr, &message);
        message
    })?;
    logs.lock().unwrap().write_line(
        crate::runner::LogChannel::Stdout,
        &format!(
            "[desktop] Bundled launcher started (PID {}). Waiting for its private channel.",
            child.id()
        ),
    );
    let stdin = child.stdin.take().ok_or("Server input unavailable")?;
    let stdout = child.stdout.take().ok_or("Server output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Server error output unavailable")?;
    let child = Arc::new(Mutex::new(child));
    *running = Some(Running {
        child: child.clone(),
        stdin,
        token: token.clone(),
    });
    *state.status.lock().unwrap() = json!({ "state": "starting", "port": 7860, "pid": null, "startedAt": null, "branch": "", "version": "", "updateAvailable": false, "commitsBehind": 0, "latestUpdateMessage": "" });
    drop(running);
    for (reader, channel) in [
        (
            Box::new(stdout) as Box<dyn std::io::Read + Send>,
            crate::runner::LogChannel::Stdout,
        ),
        (Box::new(stderr), crate::runner::LogChannel::Stderr),
    ] {
        let app = app.clone();
        let token = token.clone();
        let logs = logs.clone();
        std::thread::spawn(move || {
            let mut connected = false;
            let result = read_output(
                reader,
                |frame| {
                    if !handle_frame(&app, &token, frame) {
                        return false;
                    }
                    if !connected {
                        connected = true;
                        logs.lock().unwrap().write_line(
                            channel,
                            "[desktop] Bundled server private channel connected.",
                        );
                    }
                    if let Ok(value) = serde_json::from_str::<Value>(frame) {
                        let message = match value.get("type").and_then(Value::as_str) {
                            Some("setup") => Some(
                                "[desktop] Bundled server requested first-run setup.".to_owned(),
                            ),
                            Some("status") => value["status"]["state"]
                                .as_str()
                                .map(|state| format!("[desktop] Bundled server state: {state}")),
                            _ => None,
                        };
                        if let Some(message) = message {
                            logs.lock().unwrap().write_line(channel, &message);
                        }
                    }
                    true
                },
                |line| logs.lock().unwrap().write_line(channel, line),
            );
            if let Err(error) = result {
                let message = format!("Could not read bundled server output: {error}");
                logs.lock()
                    .unwrap()
                    .write_line(channel, &format!("[desktop] {message}"));
                let _ = app.emit_to("main", "bundled-server-error", message);
            }
        });
    }
    std::thread::spawn(move || {
        let exit = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break Ok(status),
                Err(error) => break Err(error),
                Ok(None) => {}
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let success = exit.as_ref().is_ok_and(|status| status.success());
        let message = match exit {
            Ok(status) => format!("[desktop] Bundled launcher exited: {status}"),
            Err(error) => format!("[desktop] Could not monitor bundled launcher: {error}"),
        };
        logs.lock()
            .unwrap()
            .write_line(crate::runner::LogChannel::Stdout, &message);
        let state = app.state::<BundledServerState>();
        let mut running = state.running.lock().unwrap();
        if running
            .as_ref()
            .is_some_and(|current| current.token == token)
        {
            running.take();
            for (_, reply) in state.pending.lock().unwrap().drain() {
                let _ = reply.send(Err("Server exited.".into()));
            }
            let status = {
                let mut status = state.status.lock().unwrap();
                status["state"] = json!(if success { "stopped" } else { "crashed" });
                status["pid"] = Value::Null;
                status.clone()
            };
            let _ = app.emit_to("main", "bundled-server-status", status);
            let _ = app.emit_to("main", "bundled-server-exit", success);
        }
    });
    Ok(())
}

#[cfg(test)]
mod output_tests {
    use super::*;

    #[test]
    fn native_output_cannot_hide_later_protocol_frames() {
        let mut output = b"native code-page output: \xff\xfe\r\nprogress without newline".to_vec();
        output.extend_from_slice(b"\x1e{\"type\":\"status\"}\r\n\x1e{\"type\":\"setup\"}\n");
        let mut frames = Vec::new();
        let mut logs = Vec::new();
        read_output(
            output.as_slice(),
            |frame| {
                frames.push(serde_json::from_str::<Value>(frame).unwrap());
                true
            },
            |line| logs.push(line.to_owned()),
        )
        .unwrap();
        assert_eq!(
            frames,
            [json!({"type": "status"}), json!({"type": "setup"})]
        );
        assert_eq!(logs.len(), 2);
        assert!(logs[0].starts_with("native code-page output:"));
        assert_eq!(logs[1], "progress without newline");
    }

    #[test]
    fn logs_unrecognized_records_and_final_unterminated_output() {
        let mut logs = Vec::new();
        read_output(
            &b"\x1eordinary text\nlast line"[..],
            |_| false,
            |line| logs.push(line.to_owned()),
        )
        .unwrap();
        assert_eq!(logs, ["ordinary text", "last line"]);
    }
}
#[tauri::command]
pub async fn bundled_server_stop(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_window(&window, "main")?;
    if let Some(setup) = app.get_webview_window(SETUP_WINDOW) {
        let _ = setup.close();
    }
    let state = app.state::<BundledServerState>();
    if state.running.lock().unwrap().is_none() {
        return Ok(());
    }
    let _ = request(&state, "shutdown", Value::Null).await;
    let deadline = Instant::now() + Duration::from_secs(25);
    while state.running.lock().unwrap().is_some() && Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    if state.running.lock().unwrap().is_some() {
        force_stop(&app);
    }
    Ok(())
}
#[tauri::command]
pub async fn bundled_setup_defaults(app: AppHandle, window: WebviewWindow) -> Reply {
    require_window(&window, SETUP_WINDOW)?;
    request(&app.state::<BundledServerState>(), "defaults", Value::Null).await
}
#[tauri::command]
pub async fn bundled_setup_save(app: AppHandle, window: WebviewWindow, settings: Value) -> Reply {
    require_window(&window, SETUP_WINDOW)?;
    request(&app.state::<BundledServerState>(), "configure", settings).await
}
#[tauri::command]
pub async fn bundled_setup_status(app: AppHandle, window: WebviewWindow) -> Reply {
    require_window(&window, SETUP_WINDOW)?;
    let status = request(&app.state::<BundledServerState>(), "status", Value::Null).await?;
    Ok(json!({ "state": status["setupState"], "url": status["url"] }))
}
#[cfg_attr(windows, tauri::command(async))]
#[cfg_attr(not(windows), tauri::command)]
pub fn bundled_setup_complete(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_window(&window, SETUP_WINDOW)?;
    let status = app
        .state::<BundledServerState>()
        .status
        .lock()
        .unwrap()
        .clone();
    if status["state"] != "running" {
        return Err("The server is still starting.".into());
    }
    let port = status["port"].as_u64().ok_or("Missing server port")? as u16;
    crate::frontend::show_frontend(app.clone(), port, None, app.state())?;
    window.close().map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn bundled_setup_pick_folder(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<String>, String> {
    require_window(&window, SETUP_WINDOW)?;
    Ok(crate::runner::pick_folder(app).await)
}
pub fn force_stop<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let state = app.state::<BundledServerState>();
    let mut running = state.running.lock().unwrap();
    if let Some(mut process) = running.take() {
        let message = json!({ "id": "native-exit", "type": "shutdown" });
        let _ = writeln!(process.stdin, "{message}").and_then(|_| process.stdin.flush());
        let deadline = Instant::now() + Duration::from_secs(25);
        while Instant::now() < deadline {
            if matches!(process.child.lock().unwrap().try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        crate::runner::kill_tree(&mut process.child.lock().unwrap());
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Run separately: WebView2 needs a Windows desktop, and a deadlocked
    /// native event loop must fail the process instead of hanging the suite.
    #[test]
    #[ignore = "requires native Windows WebView2; run explicitly in desktop CI"]
    fn first_run_setup_keeps_windows_event_loop_responsive() {
        let mut context = tauri::generate_context!();
        // Use real packaged setup assets without booting the tray or touching
        // an installed user's settings, server, or WebView profile.
        context.config_mut().app.windows.clear();
        context.config_mut().build.dev_url = None;
        context.config_mut().identifier =
            format!("chat.lumiverse.tray.setup-test.{}", uuid::Uuid::new_v4());
        let (completed, deadline) = std::sync::mpsc::channel();
        let (loaded, page_ready) = std::sync::mpsc::channel();
        let (responsive, observed) = std::sync::mpsc::channel();
        let watchdog = std::thread::spawn(move || {
            if deadline.recv_timeout(Duration::from_secs(30)).is_err() {
                eprintln!("First-run setup blocked the Windows event loop or failed to open");
                std::process::exit(1);
            }
        });
        let app = tauri::Builder::default()
            .any_thread()
            .manage(BundledServerState::default())
            .on_page_load(move |window, payload| {
                if window.label() == SETUP_WINDOW
                    && matches!(payload.event(), tauri::webview::PageLoadEvent::Finished)
                {
                    let _ = loaded.send(());
                }
            })
            .setup(move |app| {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    // Match the authenticated setup frame from the bundled
                    // server's background stdout reader.
                    assert!(handle_frame(
                        &handle,
                        "setup-test-token",
                        &json!({ "token": "setup-test-token", "type": "setup" }).to_string(),
                    ));
                    let until = Instant::now() + Duration::from_secs(20);
                    let window = loop {
                        if let Some(window) = handle.get_webview_window(SETUP_WINDOW) {
                            break window;
                        }
                        assert!(Instant::now() < until, "Setup window did not open");
                        std::thread::sleep(Duration::from_millis(25));
                    };
                    page_ready
                        .recv_timeout(Duration::from_secs(20))
                        .expect("setup page finished loading in WebView2");
                    assert!(window.is_visible().expect("read setup visibility"));
                    assert_eq!(
                        window.title().expect("read setup title"),
                        "Set up Lumiverse"
                    );
                    // This callback can only run once window creation has
                    // returned control to the native event loop.
                    let owner = handle.clone();
                    handle
                        .run_on_main_thread(move || {
                            responsive.send(()).expect("report event-loop probe");
                            owner.exit(0);
                        })
                        .expect("schedule event-loop responsiveness probe");
                });
                Ok(())
            })
            .build(context)
            .expect("build native setup test app");
        let profile_dir = app.path().app_local_data_dir().expect("test profile path");
        assert_eq!(app.run_return(|_, _| {}), 0);
        observed.try_recv().expect("event-loop probe completed");
        completed.send(()).expect("stop setup watchdog");
        watchdog.join().expect("join setup watchdog");
        let _ = std::fs::remove_dir_all(profile_dir);
    }
}
