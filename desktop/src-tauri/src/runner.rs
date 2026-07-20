//! Process host for the Lumiverse runner.
//!
//! Spawns `bun scripts/runner.ts --headless` with piped stdio and bridges
//! it to the TypeScript side as events:
//!
//! * `runner-frame` — one JSON protocol frame (0x1E-prefixed lines on the
//!   runner's stdout; see scripts/runner/headless-bridge.ts upstream).
//! * `runner-exit` — the runner process ended (code, if known).
//!
//! Everything else the runner prints (server logs) is appended to
//! `runner.log` in the app's log directory. This lives in Rust rather than
//! tauri-plugin-shell because macOS GUI apps don't inherit a login shell's
//! PATH — bun must be located explicitly (see `resolve_bun`).

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

const FRAME_PREFIX: u8 = 0x1e;

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
}

#[derive(Default)]
pub struct RunnerState {
    inner: Mutex<Option<Running>>,
}

fn open_log(app: &AppHandle) -> Option<std::fs::File> {
    let dir = app.path().app_log_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("runner.log"))
        .ok()
}

fn log_line(file: &mut Option<std::fs::File>, line: &str) {
    if let Some(f) = file {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(windows)]
fn suppress_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console(_cmd: &mut Command) {}

/// Start the runner as a child process. No-op if already running.
#[tauri::command]
pub fn runner_start(
    app: AppHandle,
    state: State<'_, RunnerState>,
    repo_dir: String,
    bun_path: String,
) -> Result<(), String> {
    let mut guard = state.inner.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }

    if !repo_is_valid(&repo_dir) {
        return Err(format!("Not a Lumiverse checkout: {repo_dir}"));
    }

    let mut cmd = Command::new(&bun_path);
    cmd.args(["scripts/runner.ts", "--headless"])
        .current_dir(&repo_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    suppress_console(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start runner via '{bun_path}': {e}"))?;

    let stdin = child.stdin.take().ok_or("Runner stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("Runner stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("Runner stderr unavailable")?;

    let child = Arc::new(Mutex::new(child));
    *guard = Some(Running {
        child: Arc::clone(&child),
        stdin: Mutex::new(stdin),
    });
    drop(guard);

    // stdout: split protocol frames from log passthrough.
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut log = open_log(&app);
            for line in BufReader::new(stdout).split(b'\n') {
                let Ok(bytes) = line else { break };
                if bytes.first() == Some(&FRAME_PREFIX) {
                    if let Ok(json) = String::from_utf8(bytes[1..].to_vec()) {
                        let _ = app.emit("runner-frame", json);
                    }
                } else {
                    log_line(&mut log, &String::from_utf8_lossy(&bytes));
                }
            }
        });
    }

    // stderr: log passthrough only.
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut log = open_log(&app);
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                log_line(&mut log, &line);
            }
        });
    }

    // Exit watcher: poll try_wait, then clear state and notify TS.
    std::thread::spawn(move || {
        let code = loop {
            {
                let mut child = child.lock().unwrap();
                match child.try_wait() {
                    Ok(Some(status)) => break status.code(),
                    Ok(None) => {}
                    Err(_) => break None,
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        };
        let state: State<'_, RunnerState> = app.state();
        state.inner.lock().unwrap().take();
        let _ = app.emit("runner-exit", code);
    });

    Ok(())
}

/// Write one protocol command line to the runner's stdin.
#[tauri::command]
pub fn runner_send(state: State<'_, RunnerState>, line: String) -> Result<(), String> {
    let guard = state.inner.lock().unwrap();
    let running = guard.as_ref().ok_or("Runner is not running")?;
    let mut stdin = running.stdin.lock().unwrap();
    writeln!(stdin, "{line}").map_err(|e| format!("Runner stdin write failed: {e}"))?;
    stdin.flush().map_err(|e| format!("Runner stdin flush failed: {e}"))
}

#[tauri::command]
pub fn runner_alive(state: State<'_, RunnerState>) -> bool {
    state.inner.lock().unwrap().is_some()
}

/// Force-kill the runner. Last resort — the graceful path is the `quit`
/// protocol verb, which stops the server before the runner exits.
#[tauri::command]
pub fn runner_kill(state: State<'_, RunnerState>) {
    if let Some(running) = state.inner.lock().unwrap().take() {
        let _ = running.child.lock().unwrap().kill();
    }
}

fn repo_is_valid(dir: &str) -> bool {
    Path::new(dir).join("scripts").join("runner.ts").is_file()
}

/// Check that a directory looks like a Lumiverse checkout.
#[tauri::command]
pub fn validate_repo(path: String) -> bool {
    repo_is_valid(&path)
}

/// Locate a usable bun binary. GUI apps on macOS get a minimal PATH, so
/// probe the common install locations before falling back to PATH lookup.
#[tauri::command]
pub fn resolve_bun() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        candidates.push(home.join(".bun").join("bin").join(bun_name()));
    }
    if !cfg!(windows) {
        candidates.push(PathBuf::from("/usr/local/bin/bun"));
        candidates.push(PathBuf::from("/opt/homebrew/bin/bun"));
    }
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    // Fall back to PATH resolution; verify it actually launches.
    let mut probe = Command::new(bun_name());
    probe.arg("--version").stdout(Stdio::null()).stderr(Stdio::null());
    suppress_console(&mut probe);
    match probe.status() {
        Ok(status) if status.success() => Some(bun_name().to_string()),
        _ => None,
    }
}

fn bun_name() -> &'static str {
    if cfg!(windows) {
        "bun.exe"
    } else {
        "bun"
    }
}

/// Exit the app. Called by TS after the graceful quit handshake.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Re-hide the hidden JS host window. Native dialogs and pickers can
/// activate the app in ways that reveal it (it has no close affordance),
/// so every dialog path parks it hidden again afterwards.
fn rehide_host_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

/// Show an alert with no parent window. Dialogs parented to the hidden
/// host window would drag it visible.
#[tauri::command]
pub fn alert(app: AppHandle, title: String, message: String, error: bool) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
    let app_for_rehide = app.clone();
    app.dialog()
        .message(message)
        .title(title)
        .kind(if error { MessageDialogKind::Error } else { MessageDialogKind::Info })
        .show(move |_| rehide_host_window(&app_for_rehide));
}

/// Folder picker with no parent window (see `alert`).
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = rx.recv().ok().flatten();
    rehide_host_window(&app);
    picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
}
