//! Process host for the Lumiverse runner.
//!
//! Spawns `bun scripts/runner.ts --headless` with piped stdio and bridges
//! it to the TypeScript side as events:
//!
//! * `runner-frame` — one JSON protocol frame (0x1E-prefixed lines on the
//!   runner's stdout; see scripts/runner/headless-bridge.ts upstream).
//! * `runner-exit` — the runner process ended (code, if known).
//!
//! Everything else the runner prints is written to a bounded, timestamped log
//! session in the app's log directory. A fresh `server-*.log` is selected
//! before every backend spawn/restart. This lives in Rust rather than
//! tauri-plugin-shell because macOS GUI apps don't inherit a login shell's PATH
//! — bun must be located explicitly (see `resolve_bun`).

use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const FRAME_PREFIX: u8 = 0x1e;
const LOG_SESSION_FRAME_TYPE: &str = "lumiverse-log-session-v1";
const LOG_SESSION_TOKEN_ENV: &str = "LUMIVERSE_DESKTOP_LOG_TOKEN";
const MAX_LOG_FILE_BYTES: u64 = 10 * 1024 * 1024;
const MAX_RETAINED_LOG_FILES: usize = 12;
const LOG_TRUNCATED_MARKER: &[u8] =
    b"\n[desktop launcher: log limit reached; further output was discarded]\n";

#[cfg(any(target_os = "windows", test))]
const WINDOWS_DESKTOP_UPDATE_HELPER: &str = r#"
param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$InstallerPath,
  [Parameter(Mandatory=$true)][string]$FallbackExecutable,
  [Parameter(Mandatory=$true)][string]$LogPath,
  [Parameter(Mandatory=$true)][string]$ReadyPath,
  [Parameter(Mandatory=$true)][int]$ResumeServer,
  [Parameter(Mandatory=$true)][int]$ReopenFrontend
)

$ErrorActionPreference = 'Stop'
$resumeArguments = @('--resume-after-update')
if ($ResumeServer -eq 1) { $resumeArguments += '--resume-server' }
if ($ReopenFrontend -eq 1) { $resumeArguments += '--reopen-frontend' }

function Write-UpdateLog([string]$Message) {
  $stamp = (Get-Date).ToString('o')
  Add-Content -LiteralPath $LogPath -Value "[$stamp] $Message" -Encoding UTF8
}

function Resolve-LumiverseDesktopExecutable {
  $roots = @(
    [Environment]::GetFolderPath('Programs'),
    [Environment]::GetFolderPath('CommonPrograms')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($root in $roots) {
    $link = Get-ChildItem -LiteralPath $root -Filter 'Lumiverse Desktop.lnk' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($link) {
      $shell = New-Object -ComObject WScript.Shell
      $target = $shell.CreateShortcut($link.FullName).TargetPath
      if ($target -and (Test-Path -LiteralPath $target -PathType Leaf)) {
        return $target
      }
    }
  }

  if (Test-Path -LiteralPath $FallbackExecutable -PathType Leaf) {
    return $FallbackExecutable
  }
  return $null
}

try {
  Set-Content -LiteralPath $ReadyPath -Value 'ready' -Encoding ASCII
  Write-UpdateLog "Updater helper armed; waiting for desktop PID $ParentPid to exit."

  $deadline = (Get-Date).AddSeconds(90)
  while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    if ((Get-Date) -ge $deadline) {
      throw "Timed out waiting for Lumiverse Desktop PID $ParentPid to exit"
    }
    Start-Sleep -Milliseconds 200
  }

  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    throw "Desktop installer disappeared before it could run: $InstallerPath"
  }

  Write-UpdateLog "Launching silent NSIS installer: $InstallerPath"
  $installer = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -PassThru -Wait
  if ($installer.ExitCode -ne 0) {
    throw "Desktop installer exited with code $($installer.ExitCode)"
  }

  $launch = Resolve-LumiverseDesktopExecutable
  if (-not $launch) {
    throw 'Desktop install completed, but no Lumiverse Desktop executable could be resolved for relaunch'
  }

  Write-UpdateLog "Installer completed; relaunching: $launch"
  Start-Process -FilePath $launch -ArgumentList $resumeArguments -WindowStyle Hidden | Out-Null
  Write-UpdateLog 'Desktop update handoff completed successfully.'
  exit 0
} catch {
  Write-UpdateLog "Desktop update handoff failed: $($_.Exception.Message)"
  $parentStillRunning = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
  if (-not $parentStillRunning -and (Test-Path -LiteralPath $FallbackExecutable -PathType Leaf)) {
    try {
      Write-UpdateLog "Attempting fallback relaunch: $FallbackExecutable"
      Start-Process -FilePath $FallbackExecutable -ArgumentList $resumeArguments -WindowStyle Hidden | Out-Null
    } catch {
      Write-UpdateLog "Fallback relaunch also failed: $($_.Exception.Message)"
    }
  }
  exit 1
} finally {
  Remove-Item -LiteralPath $ReadyPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue
}
"#;

struct Running {
    child: Arc<Mutex<Child>>,
    stdin: Mutex<ChildStdin>,
}

#[derive(Default)]
pub struct RunnerState {
    inner: Mutex<Option<Running>>,
}

/// Update launch intent is kept in memory and consumed once by the tray. It
/// never changes normal auto-start preferences or survives a later app launch.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateResume {
    resume_server: bool,
    reopen_frontend: bool,
}

impl DesktopUpdateResume {
    fn from_args(args: impl IntoIterator<Item = String>) -> Option<Self> {
        let args: Vec<String> = args.into_iter().collect();
        args.iter()
            .any(|arg| arg == "--resume-after-update")
            .then(|| Self {
                resume_server: args.iter().any(|arg| arg == "--resume-server"),
                reopen_frontend: args.iter().any(|arg| arg == "--reopen-frontend"),
            })
    }
}

pub struct DesktopUpdateResumeState(Mutex<Option<DesktopUpdateResume>>);

impl Default for DesktopUpdateResumeState {
    fn default() -> Self {
        Self(Mutex::new(DesktopUpdateResume::from_args(
            std::env::args().skip(1),
        )))
    }
}

#[tauri::command]
pub fn take_desktop_update_resume(
    state: State<'_, DesktopUpdateResumeState>,
) -> Option<DesktopUpdateResume> {
    state.0.lock().unwrap().take()
}

struct BoundedLog {
    file: File,
    bytes_written: u64,
    max_bytes: u64,
    capped: bool,
}

impl BoundedLog {
    fn open(path: &Path) -> std::io::Result<Self> {
        Self::open_with_limit(path, MAX_LOG_FILE_BYTES)
    }

    fn open_with_limit(path: &Path, max_bytes: u64) -> std::io::Result<Self> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let existing_bytes = file.metadata()?.len();
        if existing_bytes > max_bytes {
            file.set_len(max_bytes)?;
        }
        let bytes_written = existing_bytes.min(max_bytes);
        Ok(Self {
            file,
            bytes_written,
            max_bytes,
            capped: bytes_written >= max_bytes,
        })
    }

    fn write_bounded(&mut self, data: &[u8]) -> std::io::Result<()> {
        if self.capped || data.is_empty() {
            return Ok(());
        }

        let remaining = self.max_bytes.saturating_sub(self.bytes_written) as usize;
        if data.len() <= remaining {
            self.file.write_all(data)?;
            self.bytes_written += data.len() as u64;
            self.capped = self.bytes_written >= self.max_bytes;
            return Ok(());
        }

        let content_bytes = remaining.saturating_sub(LOG_TRUNCATED_MARKER.len());
        if content_bytes > 0 {
            self.file.write_all(&data[..content_bytes])?;
            self.bytes_written += content_bytes as u64;
        }
        let marker_bytes = (self.max_bytes.saturating_sub(self.bytes_written) as usize)
            .min(LOG_TRUNCATED_MARKER.len());
        if marker_bytes > 0 {
            self.file.write_all(&LOG_TRUNCATED_MARKER[..marker_bytes])?;
            self.bytes_written += marker_bytes as u64;
        }
        self.capped = true;
        Ok(())
    }
}

#[derive(Clone, Copy)]
enum LogChannel {
    Stdout = 0,
    Stderr = 1,
}

struct OpenLogSession {
    path: PathBuf,
    log: BoundedLog,
}

struct SessionLogs {
    dir: Option<PathBuf>,
    channel_ids: [Option<String>; 2],
    sessions: HashMap<String, OpenLogSession>,
}

impl SessionLogs {
    fn new(app: &AppHandle) -> Self {
        let dir = app.path().app_log_dir().ok().and_then(|dir| {
            fs::create_dir_all(&dir).ok()?;
            Some(dir)
        });
        Self::in_dir(dir)
    }

    fn in_dir(dir: Option<PathBuf>) -> Self {
        let mut logs = Self {
            dir,
            channel_ids: [None, None],
            sessions: HashMap::new(),
        };
        logs.start_launcher_session();
        logs
    }

    fn start_launcher_session(&mut self) {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let id = format!("launcher-{millis}-{}", std::process::id());
        if self.open_session(
            id.clone(),
            format!("launcher-{millis}-{}.log", std::process::id()),
        ) {
            self.channel_ids = [Some(id.clone()), Some(id)];
        }
    }

    fn start_server_session(&mut self, channel: LogChannel, id: &str, started_at: &str) {
        let channel_index = channel as usize;
        if self.channel_ids[channel_index].as_deref() == Some(id) {
            return;
        }

        if !self.sessions.contains_key(id) {
            let timestamp = sanitize_log_component(started_at, 40);
            let session_id = sanitize_log_component(id, 16);
            if timestamp.is_empty()
                || session_id.is_empty()
                || !self.open_session(
                    id.to_owned(),
                    format!("server-{timestamp}-{session_id}.log"),
                )
            {
                return;
            }
        }

        self.channel_ids[channel_index] = Some(id.to_owned());
        self.close_inactive_sessions();
        self.prune();
    }

    fn open_session(&mut self, id: String, filename: String) -> bool {
        let Some(dir) = self.dir.as_ref() else {
            return false;
        };
        let path = dir.join(filename);
        let Ok(log) = BoundedLog::open(&path) else {
            return false;
        };
        self.sessions.insert(id, OpenLogSession { path, log });
        self.prune();
        true
    }

    fn close_inactive_sessions(&mut self) {
        self.sessions.retain(|id, _| {
            self.channel_ids
                .iter()
                .any(|channel_id| channel_id.as_deref() == Some(id.as_str()))
        });
    }

    fn prune(&self) {
        let Some(dir) = self.dir.as_ref() else {
            return;
        };
        let protected: Vec<&Path> = self
            .sessions
            .values()
            .map(|session| session.path.as_path())
            .collect();
        prune_managed_logs(dir, &protected, MAX_RETAINED_LOG_FILES);
    }

    fn write_chunk(&mut self, channel: LogChannel, data: &str) {
        let channel_index = channel as usize;
        let Some(id) = self.channel_ids[channel_index].clone() else {
            return;
        };
        let failed = self
            .sessions
            .get_mut(&id)
            .is_some_and(|session| session.log.write_bounded(data.as_bytes()).is_err());
        if failed {
            self.sessions.remove(&id);
            for channel_id in &mut self.channel_ids {
                if channel_id.as_deref() == Some(&id) {
                    *channel_id = None;
                }
            }
        }
    }

    fn write_line(&mut self, channel: LogChannel, line: &str) {
        self.write_chunk(channel, line);
        self.write_chunk(channel, "\n");
    }
}

fn sanitize_log_component(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter_map(|ch| match ch {
            ':' | '.' => Some('-'),
            ch if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' => Some(ch),
            _ => None,
        })
        .take(max_chars)
        .collect()
}

fn is_managed_log_name(name: &str) -> bool {
    name == "runner.log"
        || ((name.starts_with("launcher-") || name.starts_with("server-"))
            && name.ends_with(".log"))
}

fn prune_managed_logs(dir: &Path, protected: &[&Path], keep: usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut logs: Vec<(SystemTime, PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if !is_managed_log_name(name) {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    logs.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));

    let mut excess = logs.len().saturating_sub(keep);
    for (_, path) in logs {
        if excess == 0 {
            break;
        }
        if protected.iter().any(|protected| *protected == path) {
            continue;
        }
        if fs::remove_file(path).is_ok() {
            excess -= 1;
        }
    }
}

fn with_logs(logs: &Arc<Mutex<SessionLogs>>, write: impl FnOnce(&mut SessionLogs)) {
    if let Ok(mut logs) = logs.lock() {
        write(&mut logs);
    }
}

/// In `tauri dev`, the native application has a console. Mirror the runner's
/// captured output there so a failed backend start is diagnosable without
/// locating the app-data log file. Release builds remain tray-only and write
/// exclusively to the current timestamped session log.
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

fn log_session_frame(json: &str, expected_token: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    if value.get("type")?.as_str()? != LOG_SESSION_FRAME_TYPE {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("token")?.as_str()? != expected_token {
        return None;
    }
    Some((
        payload.get("id")?.as_str()?.to_owned(),
        payload.get("startedAt")?.as_str()?.to_owned(),
    ))
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
    let log_session_token = uuid::Uuid::new_v4().to_string();
    cmd.args(["scripts/runner.ts", "--headless"])
        .current_dir(&repo_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.env(LOG_SESSION_TOKEN_ENV, &log_session_token);
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

    // Both reader threads share the session store but keep independent channel
    // bindings. A delayed line can therefore never cross a restart boundary.
    // Markers are authenticated because stderr may also carry raw backend text.
    let logs = Arc::new(Mutex::new(SessionLogs::new(&app)));

    // stdout: protocol frames. {type:"log"} frames carry server output
    // and go to the active server-session log; everything else is forwarded
    // to TS. Log-session frames are native-only lifecycle markers.
    {
        let app = app.clone();
        let logs = Arc::clone(&logs);
        let log_session_token = log_session_token.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).split(b'\n') {
                let Ok(bytes) = line else { break };
                if bytes.first() == Some(&FRAME_PREFIX) {
                    if let Ok(json) = String::from_utf8(bytes[1..].to_vec()) {
                        if let Some((id, started_at)) = log_session_frame(&json, &log_session_token)
                        {
                            with_logs(&logs, |logs| {
                                logs.start_server_session(LogChannel::Stdout, &id, &started_at)
                            });
                            continue;
                        }
                        match log_frame_data(&json) {
                            Some(data) => {
                                with_logs(&logs, |logs| {
                                    logs.write_chunk(LogChannel::Stdout, &data)
                                });
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
                    with_logs(&logs, |logs| logs.write_line(LogChannel::Stdout, &line));
                    mirror_to_dev_console("runner", &format!("{line}\n"));
                }
            }
        });
    }

    // stderr: log passthrough only.
    {
        let logs = Arc::clone(&logs);
        let log_session_token = log_session_token.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                if let Some(json) = line.strip_prefix(FRAME_PREFIX as char) {
                    if let Some((id, started_at)) = log_session_frame(json, &log_session_token) {
                        with_logs(&logs, |logs| {
                            logs.start_server_session(LogChannel::Stderr, &id, &started_at)
                        });
                        continue;
                    }
                }
                with_logs(&logs, |logs| logs.write_line(LogChannel::Stderr, &line));
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

/// Clean up any owned runner left at application exit. The tray's normal
/// Quit action performs a graceful protocol shutdown first; native exit paths
/// and a failed JS handshake use this process-tree fallback on every platform.
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

/// The commit this desktop shell was compiled from, or `None` when the build
/// carried no git metadata to stamp (a source-archive build, for example).
///
/// The runner compares this against the checkout to decide whether a pulled
/// update contains desktop changes the running binary predates.
#[tauri::command]
pub fn desktop_shell_sha() -> Option<String> {
    let sha = env!("LUMIVERSE_DESKTOP_SHA");
    if sha.is_empty() {
        None
    } else {
        Some(sha.to_owned())
    }
}

#[cfg(any(target_os = "windows", test))]
fn validate_desktop_update_artifact(
    artifact_path: &str,
    repo_dir: &str,
) -> Result<PathBuf, String> {
    if !repo_is_valid(repo_dir) {
        return Err("The configured folder is not a Lumiverse checkout".to_owned());
    }
    let repo = Path::new(repo_dir)
        .canonicalize()
        .map_err(|error| format!("Could not resolve the configured Lumiverse checkout: {error}"))?;
    let bundle_dir = repo
        .join("desktop")
        .join("src-tauri")
        .join("target")
        .join("release")
        .join("bundle")
        .join("nsis")
        .canonicalize()
        .map_err(|error| format!("Could not resolve the desktop NSIS bundle directory: {error}"))?;
    let artifact = Path::new(artifact_path)
        .canonicalize()
        .map_err(|error| format!("Could not resolve the rebuilt desktop installer: {error}"))?;

    if !artifact.is_file() {
        return Err("The rebuilt desktop installer is not a file".to_owned());
    }
    if artifact
        .extension()
        .and_then(|extension| extension.to_str())
        .map_or(true, |extension| !extension.eq_ignore_ascii_case("exe"))
    {
        return Err(
            "Automatic desktop replacement only accepts the Windows NSIS .exe bundle"
                .to_owned(),
        );
    }
    if artifact.strip_prefix(&bundle_dir).is_err() {
        return Err(
            "Refusing to run a desktop installer outside this checkout's release/bundle/nsis directory"
                .to_owned(),
        );
    }

    Ok(artifact)
}

/// Arm a detached Windows updater that waits for this process to exit, runs the
/// freshly built NSIS bundle silently, and relaunches the installed app. The
/// helper writes a ready marker before this command succeeds, so the JS side
/// never quits on faith that PowerShell happened to launch correctly.
#[tauri::command]
pub fn stage_desktop_update(
    app: AppHandle,
    artifact_path: String,
    repo_dir: String,
    resume_server: bool,
    reopen_frontend: bool,
) -> Result<String, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, artifact_path, repo_dir, resume_server, reopen_frontend);
        Err("Automatic desktop replacement is currently supported only on Windows".to_owned())
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let artifact = validate_desktop_update_artifact(&artifact_path, &repo_dir)?;
        let current_exe = std::env::current_exe()
            .map_err(|error| {
                format!("Could not resolve the running desktop executable: {error}")
            })?;
        let current_exe = current_exe.canonicalize().unwrap_or(current_exe);

        let log_dir = app
            .path()
            .app_log_dir()
            .map_err(|error| format!("Could not resolve the desktop log directory: {error}"))?;
        fs::create_dir_all(&log_dir)
            .map_err(|error| format!("Could not create the desktop log directory: {error}"))?;
        let log_path = log_dir.join("desktop-update.log");

        let token = uuid::Uuid::new_v4();
        let temp_dir = std::env::temp_dir();
        let helper_path = temp_dir.join(format!("lumiverse-desktop-update-{token}.ps1"));
        let ready_path = temp_dir.join(format!("lumiverse-desktop-update-{token}.ready"));
        fs::write(&helper_path, WINDOWS_DESKTOP_UPDATE_HELPER)
            .map_err(|error| format!("Could not write the desktop updater helper: {error}"))?;

        let mut command = Command::new("powershell.exe");
        command
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-WindowStyle",
                "Hidden",
                "-File",
            ])
            .arg(&helper_path)
            .arg("-ParentPid")
            .arg(std::process::id().to_string())
            .arg("-InstallerPath")
            .arg(&artifact)
            .arg("-FallbackExecutable")
            .arg(&current_exe)
            .arg("-LogPath")
            .arg(&log_path)
            .arg("-ReadyPath")
            .arg(&ready_path)
            .arg("-ResumeServer")
            .arg(if resume_server { "1" } else { "0" })
            .arg("-ReopenFrontend")
            .arg(if reopen_frontend { "1" } else { "0" })
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);

        let mut helper = command
            .spawn()
            .map_err(|error| format!("Could not launch the desktop updater helper: {error}"))?;

        let mut armed = false;
        for _ in 0..50 {
            if ready_path.is_file() {
                armed = true;
                break;
            }
            if let Some(status) = helper
                .try_wait()
                .map_err(|error| format!("Could not inspect the desktop updater helper: {error}"))?
            {
                let _ = fs::remove_file(&helper_path);
                let _ = fs::remove_file(&ready_path);
                return Err(format!(
                    "Desktop updater helper exited before arming itself ({status}). See {}",
                    log_path.display()
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }

        if !armed {
            let _ = helper.kill();
            let _ = fs::remove_file(&helper_path);
            let _ = fs::remove_file(&ready_path);
            return Err(format!(
                "Desktop updater helper did not become ready within 5 seconds. See {}",
                log_path.display()
            ));
        }

        // The helper owns cleanup from here. Removing the marker now is safe:
        // it has already passed the only readiness checkpoint and is waiting
        // solely on this process's PID.
        let _ = fs::remove_file(&ready_path);
        Ok(log_path.to_string_lossy().into_owned())
    }
}

/// Locate a usable bun binary. GUI apps on macOS get a minimal PATH, so
/// probe the common install locations before falling back to PATH lookup.
#[tauri::command]
pub fn resolve_bun() -> Option<String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(install) = std::env::var_os("BUN_INSTALL") {
        candidates.push(PathBuf::from(install).join("bin").join(bun_name()));
    }
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

/// Exit after the JS graceful handshake, cleaning up any remaining runner.
/// Process-tree termination can block, so keep it off the native event loop.
#[tauri::command(async)]
pub fn quit_app(app: AppHandle) {
    force_stop(&app);
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

/// Two-button question with no parent window (see `alert`). Resolves to
/// `true` when the user picks the affirmative button.
///
/// `async` so the blocking `recv` runs on Tauri's command pool rather than
/// the main thread the dialog itself needs — the same shape as `pick_folder`.
#[tauri::command]
pub async fn confirm(
    app: AppHandle,
    title: String,
    message: String,
    ok_label: String,
    cancel_label: String,
) -> bool {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(ok_label, cancel_label))
        .show(move |answer| {
            let _ = tx.send(answer);
        });
    let answer = rx.recv().unwrap_or(false);
    rehide_host_window(&app);
    answer
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

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lumiverse-runner-log-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bounded_log_stops_at_limit_and_records_truncation() {
        let dir = test_dir();
        let path = dir.join("server-cap.log");
        let mut log = BoundedLog::open_with_limit(&path, 256).unwrap();

        log.write_bounded(&vec![b'x'; 512]).unwrap();
        let capped_size = fs::metadata(&path).unwrap().len();
        assert_eq!(capped_size, 256);
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("log limit reached"));

        log.write_bounded(b"must be discarded").unwrap();
        assert_eq!(fs::metadata(&path).unwrap().len(), capped_size);
        drop(log);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn channel_markers_do_not_move_delayed_output_to_the_next_session() {
        let dir = test_dir();
        let mut logs = SessionLogs::in_dir(Some(dir.clone()));
        let launcher_id = logs.channel_ids[LogChannel::Stderr as usize]
            .clone()
            .unwrap();
        let launcher_path = logs.sessions[&launcher_id].path.clone();

        let session_id = "server-session-123";
        logs.start_server_session(LogChannel::Stdout, session_id, "2026-09-17T22:17:30.123Z");
        let server_path = logs.sessions[session_id].path.clone();
        logs.write_line(LogChannel::Stdout, "new-session stdout");
        logs.write_line(LogChannel::Stderr, "delayed launcher stderr");
        logs.start_server_session(LogChannel::Stderr, session_id, "2026-09-17T22:17:30.123Z");
        drop(logs);

        let server_contents = fs::read_to_string(server_path).unwrap();
        let launcher_contents = fs::read_to_string(launcher_path).unwrap();
        assert!(server_contents.contains("new-session stdout"));
        assert!(!server_contents.contains("delayed launcher stderr"));
        assert!(launcher_contents.contains("delayed launcher stderr"));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn retention_prunes_only_managed_inactive_logs() {
        let dir = test_dir();
        let protected = dir.join("server-protected.log");
        for name in [
            "server-protected.log",
            "server-1.log",
            "server-2.log",
            "launcher-3.log",
            "notes.txt",
        ] {
            fs::write(dir.join(name), name).unwrap();
        }

        prune_managed_logs(&dir, &[protected.as_path()], 2);

        let managed_count = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_str().is_some_and(is_managed_log_name))
            .count();
        assert_eq!(managed_count, 2);
        assert!(protected.exists());
        assert!(dir.join("notes.txt").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn log_filename_components_are_portable() {
        assert_eq!(
            sanitize_log_component("2026-09-17T22:17:30.123Z", 40),
            "2026-09-17T22-17-30-123Z"
        );
        assert_eq!(sanitize_log_component("../bad:id?", 40), "--bad-id");
    }

    #[test]
    fn session_markers_require_the_native_host_token() {
        let json = serde_json::json!({
            "type": LOG_SESSION_FRAME_TYPE,
            "id": "session-id",
            "payload": {
                "id": "session-id",
                "startedAt": "2026-09-17T22:17:30.123Z",
                "token": "native-secret"
            }
        })
        .to_string();

        assert_eq!(
            log_session_frame(&json, "native-secret"),
            Some((
                "session-id".to_owned(),
                "2026-09-17T22:17:30.123Z".to_owned()
            ))
        );
        assert_eq!(log_session_frame(&json, "backend-output"), None);
    }

    #[test]
    fn desktop_update_artifact_must_be_the_checkout_nsis_bundle() {
        let dir = test_dir();
        let scripts = dir.join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(scripts.join("runner.ts"), b"fixture").unwrap();
        let bundle = dir
            .join("desktop")
            .join("src-tauri")
            .join("target")
            .join("release")
            .join("bundle")
            .join("nsis");
        fs::create_dir_all(&bundle).unwrap();
        let installer = bundle.join("Lumiverse Desktop_0.3.0_x64-setup.exe");
        fs::write(&installer, b"fixture").unwrap();
        let outside = dir.join("not-the-bundle.exe");
        fs::write(&outside, b"fixture").unwrap();
        let wrong_type = bundle.join("Lumiverse Desktop_0.3.0_x64.msi");
        fs::write(&wrong_type, b"fixture").unwrap();

        assert_eq!(
            validate_desktop_update_artifact(
                installer.to_str().unwrap(),
                dir.to_str().unwrap(),
            )
            .unwrap(),
            installer.canonicalize().unwrap(),
        );
        assert!(validate_desktop_update_artifact(
            outside.to_str().unwrap(),
            dir.to_str().unwrap(),
        )
        .unwrap_err()
        .contains("outside this checkout"));
        assert!(validate_desktop_update_artifact(
            wrong_type.to_str().unwrap(),
            dir.to_str().unwrap(),
        )
        .unwrap_err()
        .contains("NSIS .exe"));

        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn desktop_update_resume_requires_an_update_launch_and_preserves_stopped_state() {
        let parse = |args: &[&str]| {
            DesktopUpdateResume::from_args(args.iter().map(|arg| (*arg).to_owned()))
        };
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&["--resume-server", "--reopen-frontend"]), None);
        assert_eq!(
            parse(&["--resume-after-update"]),
            Some(DesktopUpdateResume {
                resume_server: false,
                reopen_frontend: false
            }),
        );
        assert_eq!(
            parse(&["--resume-after-update", "--resume-server"]),
            Some(DesktopUpdateResume {
                resume_server: true,
                reopen_frontend: false
            }),
        );
        assert_eq!(
            parse(&["--resume-after-update", "--reopen-frontend"]),
            Some(DesktopUpdateResume {
                resume_server: false,
                reopen_frontend: true
            }),
        );
        let resume = parse(&[
            "--resume-after-update",
            "--resume-server",
            "--reopen-frontend",
        ]);
        assert_eq!(
            serde_json::to_value(&resume).unwrap(),
            serde_json::json!({
                "resumeServer": true, "reopenFrontend": true,
            })
        );
        let state = DesktopUpdateResumeState(Mutex::new(resume.clone()));
        assert_eq!(state.0.lock().unwrap().take(), resume);
        assert_eq!(state.0.lock().unwrap().take(), None);
    }

    #[test]
    fn desktop_update_helper_arms_before_waiting_and_relaunches_after_nsis() {
        let script = WINDOWS_DESKTOP_UPDATE_HELPER;
        let ready = script.find("Set-Content -LiteralPath $ReadyPath").unwrap();
        let wait = script.find("while (Get-Process -Id $ParentPid").unwrap();
        let install = script
            .find("Start-Process -FilePath $InstallerPath -ArgumentList '/S'")
            .unwrap();
        let relaunch = script.find("Start-Process -FilePath $launch").unwrap();

        assert!(ready < wait);
        assert!(wait < install);
        assert!(install < relaunch);
        assert!(script.contains("Lumiverse Desktop.lnk"));
        assert!(script.contains("Attempting fallback relaunch"));
        assert!(script.contains("Remove-Item -LiteralPath $PSCommandPath"));
    }
}
