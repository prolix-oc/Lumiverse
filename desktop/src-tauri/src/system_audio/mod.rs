//! Native adapter behind `ctx.systemAudio` (the Spindle `system_audio` permission).
//!
//! What crosses IPC, and what does not:
//! - **Out of native code:** analysis frames only (levels and 64 log-spaced bands, optionally per channel), as raw little-endian
//!   `f32`s over a Tauri channel. Samples, device names and file paths never leave the capture thread.
//! - **Into native code:** "start at N fps", optional stereo, and "stop". The page cannot choose a device or arbitrary format.
//!
//! The guarantee that listening is never silent lives here, not in the page. Extension code shares the frontend's
//! JavaScript realm, so the web layer's per-start prompt is a courtesy it cannot enforce against a forged call. Native
//! code therefore requires the owner to switch the feature on in the tray (off by default), and the tray shows
//! whenever a session is running. Sessions also end on lock, suspend, owner stop, and when the page reloads, closes
//! or stops listening.
//!
//! Only the primary `frontend` window may start or stop a session; only the bundled tray host may flip the switch.
//! The floating-widget windows get no grant at all.

mod analyzer;
#[cfg(any(target_os = "windows", test))]
mod channels;
#[cfg(target_os = "macos")]
mod coreaudio;
mod engine;
#[cfg(any(target_os = "linux", test))]
mod pipe;
#[cfg(target_os = "linux")]
mod pulse;
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
mod unsupported;
#[cfg(target_os = "windows")]
mod wasapi;

#[cfg(target_os = "macos")]
use coreaudio as platform;
#[cfg(target_os = "linux")]
use pulse as platform;
#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
use unsupported as platform;
#[cfg(target_os = "windows")]
use wasapi as platform;

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use analyzer::{Frame, KIND_FRAME, KIND_HOST_DISABLED, KIND_SOURCE_LOST};
use serde::Serialize;
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};

const FRONTEND: &str = "frontend";
const TRAY: &str = "main";
const STATE_EVENT: &str = "desktop-system-audio-state";
const MAX_FPS: u32 = 30;

type Events = Channel<InvokeResponseBody>;

struct Session {
    id: u64,
    /// Identifies this adapter installation, so an old page cleanup cannot stop a newer adapter's session.
    session_key: String,
    /// None while the device is opening. Stop and page departure must also end this pending session.
    capture: Option<platform::Capture>,
    events: Events,
    cancelled: Arc<AtomicBool>,
}

struct Inner {
    enabled: bool,
    session: Option<Session>,
}

pub struct SystemAudioState {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    /// True while the frontend window is hidden or minimised; capture threads read it to skip all analysis.
    paused: Arc<AtomicBool>,
}

impl Default for SystemAudioState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                enabled: false,
                session: None,
            }),
            next_id: AtomicU64::new(0),
            paused: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// This build can hear the device's output at all.
    supported: bool,
    /// The owner has switched the feature on in the tray.
    enabled: bool,
    /// A session is opening or running right now.
    active: bool,
    stereo_supported: bool,
}

fn status_of(inner: &Inner) -> Status {
    let supported = platform::supported();
    Status {
        supported,
        enabled: inner.enabled,
        active: inner.session.is_some(),
        stereo_supported: supported,
    }
}

fn publish<R: Runtime>(app: &AppHandle<R>, status: &Status) {
    for label in [TRAY, FRONTEND] {
        let _ = app.emit_to(label, STATE_EVENT, status.clone());
    }
}

fn lock(state: &SystemAudioState) -> Result<std::sync::MutexGuard<'_, Inner>, String> {
    state
        .inner
        .lock()
        .map_err(|_| "System audio state is unavailable".to_string())
}

/// Stop the running session, if any. `farewell` is told to the page first (the page ends its own side on receipt).
fn end_session(inner: &mut Inner, farewell: Option<f32>) {
    if let Some(session) = inner.session.take() {
        session.cancelled.store(true, Ordering::SeqCst);
        if let Some(capture) = session.capture {
            capture.stop();
        }
        if let Some(kind) = farewell {
            let _ = session
                .events
                .send(InvokeResponseBody::Raw(Frame::default().encode(kind)));
        }
    }
}

fn begin_session(
    inner: &mut Inner,
    id: u64,
    session_key: String,
    events: Events,
) -> Result<Arc<AtomicBool>, String> {
    if !inner.enabled {
        return Err("System audio is turned off in the Lumiverse desktop client".into());
    }
    end_session(inner, None);
    let cancelled = Arc::new(AtomicBool::new(false));
    inner.session = Some(Session {
        id,
        session_key,
        capture: None,
        events,
        cancelled: cancelled.clone(),
    });
    Ok(cancelled)
}

fn stop_adapter(inner: &mut Inner, session_key: &str) {
    if inner
        .session
        .as_ref()
        .is_some_and(|session| session.session_key == session_key)
    {
        end_session(inner, None);
    }
}

fn complete_session(inner: &mut Inner, id: u64, capture: platform::Capture) -> Result<(), String> {
    if let Some(session) = inner.session.as_mut().filter(|session| session.id == id) {
        session.capture = Some(capture);
        Ok(())
    } else {
        capture.stop();
        Err("System audio was cancelled or ended while the device was opening".into())
    }
}

fn finish_session(inner: &mut Inner, id: u64, exit: platform::Exit) -> bool {
    if !matches!(&inner.session, Some(session) if session.id == id) {
        return false;
    }
    end_session(
        inner,
        (exit == platform::Exit::Lost).then_some(KIND_SOURCE_LOST),
    );
    true
}

fn require_frontend(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == FRONTEND {
        Ok(())
    } else {
        Err("Only the primary frontend can analyse system audio".into())
    }
}

/// Readable by the frontend (to answer `isAvailable()` without prompting) and by the tray.
#[tauri::command]
pub fn desktop_system_audio_status(state: State<'_, SystemAudioState>) -> Result<Status, String> {
    Ok(status_of(&*lock(&state)?))
}

/// The owner's switch. Tray host only, and off at every launch until the tray restores a saved choice.
#[tauri::command]
pub fn desktop_system_audio_set_enabled(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SystemAudioState>,
    enabled: bool,
) -> Result<(), String> {
    crate::capture::trusted_host(&window)
        .map_err(|_| "System audio controls require the bundled tray host".to_string())?;
    if enabled && !platform::supported() {
        return Err("System audio analysis is not available on this OS yet".into());
    }
    let status = {
        let mut inner = lock(&state)?;
        inner.enabled = enabled;
        if !enabled {
            end_session(&mut inner, Some(KIND_HOST_DISABLED));
        }
        status_of(&inner)
    };
    publish(&app, &status);
    Ok(())
}

/// Begin analysing at `max_fps` (1 – 30). Replaces any session an earlier page load left behind. The web layer has
/// already asked the user; this refuses unless the owner has also switched the feature on in the tray.
#[tauri::command]
pub async fn desktop_system_audio_start(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SystemAudioState>,
    events: Events,
    max_fps: u32,
    session_key: String,
    stereo: Option<bool>,
) -> Result<(), String> {
    require_frontend(&window)?;
    if session_key.is_empty() || session_key.len() > 128 {
        return Err("Invalid system audio session key".into());
    }
    let (id, cancelled, status) = {
        let mut inner = lock(&state)?;
        let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let cancelled = begin_session(&mut inner, id, session_key, events.clone())?;
        state.paused.store(
            !(window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)),
            Ordering::Relaxed,
        );
        (id, cancelled, status_of(&inner))
    };
    // Show native activity before the device can deliver any audio.
    publish(&app, &status);

    let options = platform::Options::new(
        Duration::from_secs_f64(1.0 / f64::from(max_fps.clamp(1, MAX_FPS))),
        state.paused.clone(),
    )
    .with_stereo(stereo.unwrap_or(false));
    let (frames, notify) = (events, app.clone());
    let capture = tauri::async_runtime::spawn_blocking(move || {
        platform::start(
            options,
            move |frame| {
                !cancelled.load(Ordering::SeqCst)
                    && frames
                        .send(InvokeResponseBody::Raw(frame.encode(KIND_FRAME)))
                        .is_ok()
            },
            move |exit| {
                finished(&notify, id, exit);
            },
        )
    })
    .await
    .map_err(|_| "The system audio thread failed".to_string())
    .and_then(|capture| capture);

    let (result, status) = {
        let mut inner = lock(&state)?;
        let result = match capture {
            Ok(capture) => complete_session(&mut inner, id, capture),
            Err(error) => {
                finish_session(&mut inner, id, platform::Exit::Lost);
                Err(error)
            }
        };
        (result, status_of(&inner))
    };
    publish(&app, &status);
    result
}

#[tauri::command]
pub fn desktop_system_audio_stop(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, SystemAudioState>,
    session_key: String,
) -> Result<(), String> {
    require_frontend(&window)?;
    let status = {
        let mut inner = lock(&state)?;
        stop_adapter(&mut inner, &session_key);
        status_of(&inner)
    };
    publish(&app, &status);
    Ok(())
}

/// Runs on the capture thread once the device is released. A session that ended because its owner stopped it is
/// already gone from the state, so only a loss the page does not know about is reported.
fn finished<R: Runtime>(app: &AppHandle<R>, id: u64, exit: platform::Exit) {
    let Some(state) = app.try_state::<SystemAudioState>() else {
        return;
    };
    let status = {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if !finish_session(&mut inner, id, exit) {
            return;
        }
        status_of(&inner)
    };
    publish(app, &status);
}

/// The frontend window is hidden or minimised (`false`) or visible again (`true`). Capture threads see this on their
/// next wake-up and stop analysing; the session itself stays open.
pub fn frontend_visible<R: Runtime>(app: &AppHandle<R>, visible: bool) {
    if let Some(state) = app.try_state::<SystemAudioState>() {
        state.paused.store(!visible, Ordering::Relaxed);
    }
}

/// The page that owned the session is gone (reload, navigation, window destroyed). Nothing is left to receive frames.
pub fn frontend_gone<R: Runtime>(app: &AppHandle<R>) {
    let Some(state) = app.try_state::<SystemAudioState>() else {
        return;
    };
    let status = {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if inner.session.is_none() {
            return;
        }
        end_session(&mut inner, None);
        status_of(&inner)
    };
    publish(app, &status);
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::{Device, Fault};

    struct SilentDevice;
    impl Device for SilentDevice {
        fn sample_rate(&self) -> u32 {
            48_000
        }
        fn drain(&mut self, _: &mut analyzer::Analyzer, _: bool) -> Result<f32, Fault> {
            Ok(0.0)
        }
    }

    fn capture() -> platform::Capture {
        engine::spawn(
            engine::Options::new(Duration::from_secs(1), Arc::new(AtomicBool::new(false))),
            || {
                Ok(engine::Session {
                    device: SilentDevice,
                    reopen: Box::new(|_| None),
                    interrupted: Box::new(|| false),
                    keep: Box::new(()),
                })
            },
            |_| true,
            |_| {},
        )
        .unwrap()
    }

    fn rig() -> (Inner, Events, Arc<Mutex<Vec<Vec<u8>>>>) {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let sink = messages.clone();
        let events = Channel::new(move |body| {
            match body {
                InvokeResponseBody::Raw(bytes) => sink.lock().unwrap().push(bytes),
                _ => panic!("Only encoded analysis may cross IPC"),
            }
            Ok(())
        });
        (
            Inner {
                enabled: true,
                session: None,
            },
            events,
            messages,
        )
    }

    #[test]
    fn stopping_a_pending_open_rejects_its_late_capture() {
        let (mut inner, events, _) = rig();
        let cancelled = begin_session(&mut inner, 1, "adapter".into(), events).unwrap();
        stop_adapter(&mut inner, "adapter");
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(complete_session(&mut inner, 1, capture()).is_err());
        assert!(inner.session.is_none());
    }

    #[test]
    fn page_departure_also_cancels_a_pending_open() {
        let (mut inner, events, _) = rig();
        let cancelled = begin_session(&mut inner, 1, "adapter".into(), events).unwrap();
        end_session(&mut inner, None);
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(complete_session(&mut inner, 1, capture()).is_err());
    }

    #[test]
    fn disabling_and_reenabling_cannot_revive_an_old_open() {
        let (mut inner, events, messages) = rig();
        begin_session(&mut inner, 1, "adapter".into(), events).unwrap();
        inner.enabled = false;
        end_session(&mut inner, Some(KIND_HOST_DISABLED));
        inner.enabled = true;
        assert!(complete_session(&mut inner, 1, capture()).is_err());
        let bytes = &messages.lock().unwrap()[0];
        assert_eq!(
            f32::from_le_bytes(bytes[..4].try_into().unwrap()),
            KIND_HOST_DISABLED
        );
    }

    #[test]
    fn a_stale_open_or_stop_cannot_replace_or_end_a_new_adapter() {
        let (mut inner, events, _) = rig();
        let cancelled = begin_session(&mut inner, 1, "old".into(), events.clone()).unwrap();
        begin_session(&mut inner, 2, "new".into(), events).unwrap();
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(complete_session(&mut inner, 1, capture()).is_err());
        assert!(!finish_session(&mut inner, 1, platform::Exit::Lost));
        stop_adapter(&mut inner, "old");
        assert_eq!(inner.session.as_ref().unwrap().id, 2);
        complete_session(&mut inner, 2, capture()).unwrap();
        assert!(inner.session.as_ref().unwrap().capture.is_some());
        end_session(&mut inner, None);
    }

    #[test]
    fn loss_during_open_notifies_the_page_and_rejects_startup() {
        let (mut inner, events, messages) = rig();
        begin_session(&mut inner, 1, "adapter".into(), events).unwrap();
        assert!(finish_session(&mut inner, 1, platform::Exit::Lost));
        assert!(complete_session(&mut inner, 1, capture()).is_err());
        assert!(inner.session.is_none());
        let messages = messages.lock().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].len(), analyzer::MESSAGE_FLOATS * 4);
        assert_eq!(
            f32::from_le_bytes(messages[0][..4].try_into().unwrap()),
            KIND_SOURCE_LOST
        );
    }
}
