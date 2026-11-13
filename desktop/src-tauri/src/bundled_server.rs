//! Owns the packaged server. Configuration crosses private stdio, never HTTP.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

const SETUP_WINDOW: &str = "server-setup";
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
            }
        }
        Some("setup") => {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(error) = show_setup(handle) {
                    eprintln!("Could not open server setup: {error}");
                }
            });
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
    command.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD");
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
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not launch bundled server: {error}"))?;
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
    let logs = Arc::new(Mutex::new(crate::runner::SessionLogs::new(&app)));
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
            for line in BufReader::new(reader).lines() {
                let Ok(line) = line else {
                    break;
                };
                if let Some(frame) = line.strip_prefix('\u{1e}') {
                    if handle_frame(&app, &token, frame) {
                        continue;
                    }
                }
                logs.lock().unwrap().write_line(channel, &line);
            }
        });
    }
    std::thread::spawn(move || {
        let success = loop {
            match child.lock().unwrap().try_wait() {
                Ok(Some(status)) => break status.success(),
                Err(_) => break false,
                Ok(None) => {}
            }
            std::thread::sleep(Duration::from_millis(100));
        };
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
