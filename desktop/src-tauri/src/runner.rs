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

/// Server output arrives as arbitrary chunks (not line-aligned); write
/// them verbatim so the log file reads exactly like the server terminal.
fn log_chunk(file: &mut Option<std::fs::File>, data: &str) {
    if let Some(f) = file {
        let _ = f.write_all(data.as_bytes());
    }
}

/// In `tauri dev`, the native application has a console. Mirror the runner's
/// captured output there so a failed backend start is diagnosable without
/// locating the app-data log file. Release builds remain tray-only and write
/// exclusively to `runner.log`.
#[cfg(debug_assertions)]
fn mirror_to_dev_console(source: &str, data: &str) {
    eprint!("[lumiverse {source}] {data}");
}

#[cfg(not(debug_assertions))]
fn mirror_to_dev_console(_source: &str, _data: &str) {}

/// If `json` is a `{type:"log"}` frame, return its payload text.
fn log_frame_data(json: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    if value.get("type")?.as_str()? != "log" {
        return None;
    }
    Some(value.get("payload")?.get("data")?.as_str()?.to_owned())
}

#[cfg(windows)]
fn suppress_console(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn suppress_console(_cmd: &mut Command) {}

/// Put the runner in its own process group so a forced kill can take out
/// the whole tree (runner + server child), not just the runner.
#[cfg(unix)]
fn isolate_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn isolate_process_group(_cmd: &mut Command) {}

/// Force-kill the runner and every process it spawned.
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        // The runner is its own group leader (process_group(0) at spawn),
        // so signalling -pid reaches the server child too.
        let mut kill = Command::new("kill");
        kill.args(["-KILL", "--", &format!("-{pid}")]);
        let _ = kill.status();
    }
    #[cfg(windows)]
    {
        let mut kill = Command::new("taskkill");
        kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
        suppress_console(&mut kill);
        let _ = kill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Prepend `bun`'s directory to the child's PATH. The runner shells out
/// to git (and historically bare `bun`); a macOS GUI app's minimal PATH
/// would otherwise make those lookups fail.
fn prepend_bun_dir_to_path(cmd: &mut Command, bun_path: &str) {
    let Some(bun_dir) = Path::new(bun_path).parent() else {
        return;
    };
    if bun_dir.as_os_str().is_empty() {
        return;
    }
    let existing = std::env::var_os("PATH").unwrap_or_default();
    let paths: Vec<PathBuf> = std::iter::once(bun_dir.to_path_buf())
        .chain(std::env::split_paths(&existing))
        .collect();
    if let Ok(joined) = std::env::join_paths(paths) {
        cmd.env("PATH", joined);
    }
}

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
    prepend_bun_dir_to_path(&mut cmd, &bun_path);
    suppress_console(&mut cmd);
    isolate_process_group(&mut cmd);

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

    // stdout: protocol frames. {type:"log"} frames carry server output
    // and go to the log file; everything else is forwarded to TS.
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let mut log = open_log(&app);
            for line in BufReader::new(stdout).split(b'\n') {
                let Ok(bytes) = line else { break };
                if bytes.first() == Some(&FRAME_PREFIX) {
                    if let Ok(json) = String::from_utf8(bytes[1..].to_vec()) {
                        match log_frame_data(&json) {
                            Some(data) => {
                                log_chunk(&mut log, &data);
                                mirror_to_dev_console("server", &data);
                            }
                            None => {
                                let _ = app.emit("runner-frame", json);
                            }
                        }
                    }
                } else {
                    // Runner's own incidental output (console.log etc.).
                    let line = String::from_utf8_lossy(&bytes);
                    log_line(&mut log, &line);
                    mirror_to_dev_console("runner", &format!("{line}\n"));
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
                mirror_to_dev_console("runner stderr", &format!("{line}\n"));
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
    stdin
        .flush()
        .map_err(|e| format!("Runner stdin flush failed: {e}"))
}

#[tauri::command]
pub fn runner_alive(state: State<'_, RunnerState>) -> bool {
    state.inner.lock().unwrap().is_some()
}

/// Force-kill the runner and its process tree. Last resort — the
/// graceful path is the `quit` protocol verb, which stops the server
/// before the runner exits.
#[tauri::command]
pub fn runner_kill(state: State<'_, RunnerState>) {
    if let Some(running) = state.inner.lock().unwrap().take() {
        kill_tree(&mut running.child.lock().unwrap());
    }
}

/// Stop a runner before a native application-menu quit. The tray's normal
/// Quit action performs a graceful protocol shutdown first; this is the safe
/// fallback for Cmd-Q and the macOS application menu.
pub fn force_stop<R: tauri::Runtime>(app: &AppHandle<R>) {
    let state: State<'_, RunnerState> = app.state();
    let running = state.inner.lock().unwrap().take();
    if let Some(running) = running {
        kill_tree(&mut running.child.lock().unwrap());
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

/// Find the Lumiverse checkout this app lives inside, if any, by walking
/// up from the executable. Dev builds run from
/// `<repo>/desktop/src-tauri/target/…`, so this resolves the repo with
/// no path baked in at build time; installed copies (e.g. /Applications)
/// find nothing and the user selects the folder explicitly on first run.
#[tauri::command]
pub fn discover_repo() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let exe = exe.canonicalize().unwrap_or(exe);
    let mut dir = exe.parent();
    while let Some(candidate) = dir {
        if candidate.join("scripts").join("runner.ts").is_file() {
            return Some(candidate.to_string_lossy().into_owned());
        }
        dir = candidate.parent();
    }
    None
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
    probe
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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
        .kind(if error {
            MessageDialogKind::Error
        } else {
            MessageDialogKind::Info
        })
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
