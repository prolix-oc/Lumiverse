//! Linux system-audio capture: the monitor of the default output, read through `parec`.
//!
//! PulseAudio and PipeWire's Pulse layer both provide `@DEFAULT_MONITOR@`, so one code path covers nearly every
//! desktop. Using the program rather than linking `libpulse` means no build-time dependency, and a machine without
//! the library cannot fail to launch the app over an optional feature: if `parec` is missing, the feature is simply
//! `unsupported`. (`pulseaudio-utils`, or `pipewire-pulse` on most PipeWire systems, provides it.)
//!
//! `parec` is looked up in fixed system directories, never through `$PATH`, so a poisoned `PATH` cannot substitute a
//! different program. Pacing, silence, pause and stop live in `engine.rs`; the pipe handling in `pipe.rs`.
//!
//! Sleep is detected exactly. Lock is best effort: it asks logind (`LockedHint`), which GNOME and KDE set, and treats
//! any answer other than "yes" as unlocked. Flatpak and Snap sandboxes do not ship `parec`, so they report
//! `unsupported`.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{atomic::AtomicBool, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use super::{
    analyzer::Frame,
    engine::{spawn, Session},
    pipe::{parec_args, parse_uptime, slept, valid_session_id, Opener, PipeDevice, Running},
};
pub use super::engine::{Capture, Exit, Options};

/// Where system programs live. NixOS keeps them under `/run/current-system/sw/bin`.
const SYSTEM_DIRECTORIES: [&str; 4] = ["/usr/bin", "/bin", "/usr/local/bin", "/run/current-system/sw/bin"];
const REOPEN_TRIES: u32 = 6;
const REOPEN_WAIT: Duration = Duration::from_millis(500);
const LOCK_EVERY: Duration = Duration::from_secs(3);

fn find(program: &str) -> Option<PathBuf> {
    SYSTEM_DIRECTORIES.iter().map(|directory| Path::new(directory).join(program)).find(|path| path.is_file())
}

/// A command that does not inherit the AppImage launcher's library overrides, which can break host programs.
fn clean(path: &Path) -> Command {
    let mut command = Command::new(path);
    command.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD").stdin(Stdio::null()).stderr(Stdio::null());
    command
}

/// Whether the machine can hear its own output: `parec` is installed. Cheap and side-effect free.
pub fn supported() -> bool {
    find("parec").is_some()
}

fn opener(parec: PathBuf, interval: Duration) -> Opener {
    Arc::new(move || {
        let mut child = clean(&parec).args(parec_args(interval)).stdout(Stdio::piped()).spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "no output pipe"))?;
        let child = Arc::new(Mutex::new(child));
        Ok(Running {
            reader: Box::new(stdout),
            end: Box::new(move || {
                if let Ok(mut child) = child.lock() {
                    // Killing closes the pipe, which unblocks the reader thread; waiting reaps the process.
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }),
        })
    })
}

fn reopen(open: &Opener, interval: Duration, stop: &AtomicBool) -> Option<PipeDevice> {
    for _ in 0..REOPEN_TRIES {
        thread::sleep(REOPEN_WAIT);
        if stop.load(std::sync::atomic::Ordering::Relaxed) {
            return None;
        }
        let mut device = PipeDevice::new(open.clone(), interval);
        if device.connect().is_ok() {
            return Some(device);
        }
    }
    None
}

/// Lock and sleep, checked by the engine every half second; the lock query itself runs far less often.
fn interrupted() -> impl FnMut() -> bool {
    let uptime = || std::fs::read_to_string("/proc/uptime").ok().and_then(|text| parse_uptime(&text));
    let mut last = (Instant::now(), uptime());
    let mut next_lock_check = Instant::now() + LOCK_EVERY;
    let session = std::env::var("XDG_SESSION_ID").ok().filter(|id| valid_session_id(id));
    let loginctl = find("loginctl");
    move || {
        let now = Instant::now();
        let up = uptime();
        if let (Some(before), Some(after)) = (last.1, up) {
            if slept(before, after, now.duration_since(last.0)) {
                return true;
            }
        }
        last = (now, up);
        if now >= next_lock_check {
            next_lock_check = now + LOCK_EVERY;
            if let (Some(program), Some(id)) = (&loginctl, &session) {
                let locked = clean(program)
                    .args(["show-session", id, "--property=LockedHint", "--value"])
                    .output()
                    .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "yes")
                    .unwrap_or(false);
                if locked {
                    return true;
                }
            }
        }
        false
    }
}

/// Start listening to the default output's monitor on a dedicated thread. See `engine::spawn`.
pub fn start(
    options: Options,
    on_frame: impl FnMut(&Frame) -> bool + Send + 'static,
    on_end: impl FnOnce(Exit) + Send + 'static,
) -> Result<Capture, String> {
    let parec = find("parec").ok_or_else(|| {
        "System audio needs PulseAudio's parec (package pulseaudio-utils, or pipewire-pulse) in /usr/bin".to_string()
    })?;
    let interval = options.interval;
    let open = opener(parec, interval);
    spawn(
        options,
        move || {
            let mut device = PipeDevice::new(open.clone(), interval);
            device.connect().map_err(|_| {
                "Could not listen to the default output. Is a PulseAudio or PipeWire sound server running?".to_string()
            })?;
            Ok(Session {
                device,
                reopen: Box::new(move |stop| reopen(&open, interval, stop)),
                interrupted: Box::new(interrupted()),
                keep: Box::new(()),
            })
        },
        on_frame,
        on_end,
    )
}
