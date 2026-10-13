mod platform;
#[cfg(target_os = "windows")]
mod windows;

use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::sync::{oneshot, Notify};

use crate::remote_instance::{self, RemoteInstanceState};

const IMAGE_BYTES: usize = 8 * 1024 * 1024;
const VIDEO_BYTES: usize = 32 * 1024 * 1024;
const MAX_PIXELS: u64 = 16_777_216;
const MAX_DURATION: u64 = 30;
const API_PATH: &str = "/api/desktop/v1/capture/devices";

#[derive(Default)]
pub struct DesktopCaptureState {
    session: Mutex<Option<Arc<Session>>>,
}

struct Session {
    origin: String,
    account: Mutex<Option<String>>,
    account_id: Mutex<Option<String>>,
    stopped: AtomicBool,
    wake: Notify,
    error: Mutex<Option<String>>,
}

impl Session {
    fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }
}

#[derive(Clone, Copy, Serialize)]
pub struct Capabilities {
    image: bool,
    video: bool,
    replay: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    enabled: bool,
    origin: Option<String>,
    capabilities: Capabilities,
    error: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionIdentity {
    id: String,
    identifier: String,
    name: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Destination {
    connection_id: String,
    provider: String,
    model: String,
    endpoint_origin: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CaptureRequest {
    request_id: String,
    extension: ExtensionIdentity,
    purpose: String,
    kind: String,
    mode: Option<String>,
    duration_seconds: Option<u64>,
    destination: Destination,
    max_bytes: usize,
    max_pixels: u64,
    expires_at: u64,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Command {
    Capture(CaptureRequest),
    Cancel {
        #[serde(rename = "requestId")]
        request_id: String,
    },
}

#[derive(Deserialize)]
struct Commands {
    commands: Vec<Command>,
}

#[derive(Deserialize)]
struct RegisteredDevice {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    device: RegisteredDevice,
    transport_token: String,
}

#[derive(Deserialize)]
struct NativeAccount {
    id: String,
    name: String,
}

#[derive(Deserialize)]
struct NativePrincipal {
    account: NativeAccount,
}

impl NativePrincipal {
    fn matches(&self, account_id: &str) -> bool {
        self.account.id == account_id
            && safe_label(&self.account.id, 128)
            && safe_label(&self.account.name, 120)
    }
}

pub(super) struct Media {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
    duration_seconds: Option<f64>,
}

impl Drop for Media {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

struct Pending {
    request: CaptureRequest,
    active: Arc<AtomicBool>,
    receiver: oneshot::Receiver<Result<Media, &'static str>>,
}

#[derive(Default)]
struct PromptBudget {
    recent: VecDeque<u64>,
}

impl PromptBudget {
    fn allow(&mut self, now: u64) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|created| now.saturating_sub(*created) >= 300_000)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= 6
            || self
                .recent
                .back()
                .is_some_and(|created| now.saturating_sub(*created) < 10_000)
        {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn safe_label(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.chars().count() <= maximum && !value.chars().any(|character| {
        character.is_control() || matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
    })
}

impl CaptureRequest {
    fn validate(&self, capabilities: Capabilities, now: u64) -> Result<(), &'static str> {
        if uuid::Uuid::parse_str(&self.request_id).is_err()
            || !safe_label(&self.extension.id, 128)
            || !safe_label(&self.extension.identifier, 128)
            || !safe_label(&self.extension.name, 120)
            || !safe_label(&self.purpose, 240)
            || !safe_label(&self.destination.connection_id, 128)
            || !safe_label(&self.destination.provider, 80)
            || !safe_label(&self.destination.model, 200)
            || !safe_label(&self.destination.endpoint_origin, 256)
            || self.expires_at <= now
            || self.expires_at > now.saturating_add(120_000)
            || self.max_pixels == 0
            || self.max_pixels > MAX_PIXELS
            || self.max_bytes == 0
        {
            return Err("failed");
        }
        match self.kind.as_str() {
            "image"
                if capabilities.image
                    && self.mode.is_none()
                    && self.duration_seconds.is_none()
                    && self.max_bytes <= IMAGE_BYTES =>
            {
                Ok(())
            }
            "video"
                if capabilities.video
                    && self.mode.as_deref() == Some("record")
                    && self
                        .duration_seconds
                        .is_some_and(|duration| (1..=MAX_DURATION).contains(&duration))
                    && self.max_bytes <= VIDEO_BYTES =>
            {
                Ok(())
            }
            _ => Err("unsupported"),
        }
    }

    fn consent_text(&self, origin: &str, account: &str) -> String {
        format!("Extension: {}\nIdentifier: {}\nInstallation: {}\nInstance: {}\nDesktop account: {}\nProvider: {}\nModel: {}\nEndpoint: {}\nConnection: {}\nPurpose: {}\n\n{}\nLimit: {} MiB, {} pixels. Local expiry: {} seconds.\nApproved uploads expire from instance memory after 2 minutes.\nSelecting a source authorizes this one capture and release to the instance/model above. No capture starts before source selection. Review Before Sending pauses release for local inspection. Stop & Discard cancels without uploading.",
            self.extension.name, self.extension.identifier, self.extension.id, origin, account,
            self.destination.provider, self.destination.model, self.destination.endpoint_origin,
            self.destination.connection_id, self.purpose,
            if self.kind == "video" { format!("Record up to {} seconds. No audio. {}", self.duration_seconds.unwrap_or_default(),
                if cfg!(target_os = "windows") { "Hardware acceleration requested; Windows may fall back to software H.264." } else { "Hardware H.264 only." }) }
            else { "Take one screenshot of the source you choose. Local memory only.".into() },
            self.max_bytes / (1024 * 1024), self.max_pixels,
            self.expires_at.saturating_sub(now_ms()) / 1000)
    }

    fn consent_summary(&self, origin: &str, account: &str) -> String {
        format!(
            "{} → {} · {}\n{}\n{} · {}\n{}",
            self.extension.name,
            self.destination.provider,
            self.destination.model,
            self.destination.endpoint_origin,
            origin,
            account,
            if self.kind == "video" {
                format!(
                    "{}s video · no audio",
                    self.duration_seconds.unwrap_or_default()
                )
            } else {
                "Screenshot".into()
            }
        )
    }
}

fn trusted_host(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Capture controls require the bundled tray host".into());
    }
    let url = window.url().map_err(|_| "Could not verify the tray host")?;
    if !trusted_url(&url) {
        return Err("Capture controls are unavailable to remote content".into());
    }
    Ok(())
}

fn trusted_url(url: &Url) -> bool {
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.host_str() == Some("localhost")
        && url.port() == Some(1430);
    (bundled || development)
        && matches!(url.path(), "" | "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}

#[tauri::command]
pub fn desktop_capture_status(
    window: WebviewWindow,
    state: State<'_, DesktopCaptureState>,
) -> Result<CaptureStatus, String> {
    trusted_host(&window)?;
    let guard = state
        .session
        .lock()
        .map_err(|_| "Capture state unavailable")?;
    Ok(CaptureStatus {
        enabled: guard
            .as_ref()
            .is_some_and(|session| !session.stopped.load(Ordering::SeqCst)),
        origin: guard.as_ref().map(|session| session.origin.clone()),
        capabilities: platform::capabilities(),
        error: guard
            .as_ref()
            .and_then(|session| session.error.lock().ok()?.clone()),
    })
}

#[tauri::command]
pub async fn desktop_capture_connect(
    app: AppHandle,
    window: WebviewWindow,
    origin: String,
) -> Result<(), String> {
    trusted_host(&window)?;
    let capabilities = platform::capabilities();
    if !capabilities.image {
        return Err(
            "A consent-preserving capture adapter is not available on this OS version yet".into(),
        );
    }
    let parsed = Url::parse(&origin).map_err(|_| "Invalid instance origin")?;
    let canonical = parsed.origin().ascii_serialization();
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || (parsed.scheme() != "https"
            && !matches!(parsed.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")))
    {
        return Err("Capture requires HTTPS or a loopback instance".into());
    }
    stop(&app, None);
    let session = Arc::new(Session {
        origin: canonical.clone(),
        account: Mutex::new(None),
        account_id: Mutex::new(None),
        stopped: AtomicBool::new(false),
        wake: Notify::new(),
        error: Mutex::new(None),
    });
    *app.state::<DesktopCaptureState>()
        .session
        .lock()
        .map_err(|_| "Capture state unavailable")? = Some(session.clone());
    let oauth = app.state::<RemoteInstanceState>();
    let snapshot = if oauth.capture_access_token(&canonical).is_none() {
        match remote_instance::remote_instance_connect(app.clone(), oauth, canonical.clone()).await
        {
            Ok(snapshot) => snapshot,
            Err(error) => {
                session.stop();
                return Err(error);
            }
        }
    } else {
        remote_instance::poll_remote_instance(&oauth, canonical.clone()).await
    };
    let Some((account_id, account_name)) =
        snapshot
            .capture_account()
            .filter(|(account_id, account_name)| {
                safe_label(account_id, 128) && safe_label(account_name, 120)
            })
    else {
        session.stop();
        return Err("Could not verify the desktop OAuth account".into());
    };
    *session.account.lock().unwrap() = Some(format!("{account_name} ({account_id})"));
    *session.account_id.lock().unwrap() = Some(account_id.to_owned());
    if session.stopped.load(Ordering::SeqCst) {
        return Err("Capture connection cancelled".into());
    }
    tauri::async_runtime::spawn(async move {
        if transport(&app, &session, capabilities).await.is_err() {
            *session.error.lock().unwrap() =
                Some("Capture disconnected. Re-enable it from the tray to reconnect.".into());
        }
        session.stop();
    });
    Ok(())
}

#[tauri::command]
pub fn desktop_capture_disconnect(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    trusted_host(&window)?;
    stop(&app, None);
    Ok(())
}

pub(crate) fn stop(app: &AppHandle, origin: Option<&str>) {
    if let Some(session) = app
        .state::<DesktopCaptureState>()
        .session
        .lock()
        .unwrap()
        .as_ref()
    {
        if origin.is_none_or(|selected| selected == session.origin) {
            session.stop();
        }
    }
}

pub(crate) fn shutdown(app: &AppHandle) {
    stop(app, None);
    platform::shutdown();
}

async fn bounded_json<T: for<'input> Deserialize<'input>>(
    response: reqwest::Response,
    limit: usize,
) -> Result<T, ()> {
    if !response.status().is_success() {
        return Err(());
    }
    let mut chunks = response.bytes_stream();
    let mut body = Vec::new();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if chunk.len() > limit.saturating_sub(body.len()) {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|_| {
        eprintln!("[Lumiverse capture] invalid native control response format");
    })
}

async fn verify_account(
    client: &Client,
    origin: &str,
    token: &str,
    account_id: &str,
) -> Result<(), ()> {
    let response = client
        .get(format!("{origin}/api/desktop/v1/me"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|_| ())?;
    let principal: NativePrincipal = bounded_json(response, 4096).await?;
    if principal.matches(account_id) {
        Ok(())
    } else {
        Err(())
    }
}

async fn upload(
    client: &Client,
    endpoint: &str,
    token: &str,
    lease: &str,
    request: &CaptureRequest,
    result: Result<Media, &'static str>,
) -> Result<(), ()> {
    let mut body = match result {
        Ok(media) => {
            if media.bytes.len() > request.max_bytes
                || media.width == 0
                || media.height == 0
                || u64::from(media.width) * u64::from(media.height) > request.max_pixels
                || (request.kind == "video"
                    && !media.duration_seconds.is_some_and(|duration| {
                        duration.is_finite()
                            && duration > 0.0
                            && duration <= request.duration_seconds.unwrap_or_default() as f64
                    }))
            {
                return Err(());
            }
            let mut value = serde_json::json!({"requestId":request.request_id,"outcome":"approved","media":{
                "mimeType":if request.kind == "image" { "image/png" } else { "video/mp4" },
                "data":STANDARD.encode(&media.bytes),"width":media.width,"height":media.height
            }});
            if let Some(duration) = media.duration_seconds {
                value["media"]["durationSeconds"] = duration.into();
            }
            serde_json::to_vec(&value).map_err(|_| ())?
        }
        Err(outcome) => serde_json::to_vec(
            &serde_json::json!({"requestId":request.request_id,"outcome":outcome}),
        )
        .map_err(|_| ())?,
    };
    let payload = std::mem::take(&mut body);
    let response = client
        .post(format!("{endpoint}/responses"))
        .bearer_auth(token)
        .header("X-Lumiverse-Capture-Lease", lease)
        .header("Content-Type", "application/json")
        .body(payload)
        .send()
        .await
        .map_err(|_| ())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(())
    }
}

async fn transport(
    app: &AppHandle,
    session: &Arc<Session>,
    capabilities: Capabilities,
) -> Result<(), ()> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ())?;
    let oauth = app.state::<RemoteInstanceState>();
    let token = oauth.capture_access_token(&session.origin).ok_or(())?;
    let account_id = session
        .account_id
        .lock()
        .map_err(|_| ())?
        .clone()
        .ok_or(())?;
    tokio::select! {
        biased;
        _ = session.wake.notified() => return Ok(()),
        verified = verify_account(&client, &session.origin, &token, &account_id) => verified?,
    }
    let register = client.post(format!("{}{API_PATH}", session.origin)).bearer_auth(&token)
        .json(&serde_json::json!({"name":"Lumiverse Desktop","platform":std::env::consts::OS,"capabilities":capabilities}));
    let registration: Registration = tokio::select! {
        biased;
        _ = session.wake.notified() => return Ok(()),
        result = async { bounded_json(register.send().await.map_err(|_| ())?, 4096).await } => result?,
    };
    if uuid::Uuid::parse_str(&registration.device.id).is_err()
        || registration.transport_token.len() > 256
        || registration.transport_token.len() < 32
    {
        return Err(());
    }
    let endpoint = format!("{}{API_PATH}/{}", session.origin, registration.device.id);
    let mut pending: Option<Pending> = None;
    let mut validated_token = token;
    let account = session.account.lock().map_err(|_| ())?.clone().ok_or(())?;
    let mut prompt_budget = PromptBudget::default();
    let result = async {
        loop {
            if session.stopped.load(Ordering::SeqCst) { return Ok(()); }
            let mut token = oauth.capture_access_token(&session.origin);
            if token.is_none() {
                if let Some(active) = pending.as_ref() {
                    active.active.store(false, Ordering::SeqCst);
                    platform::cancel(app, &active.request.request_id);
                }
                if session.stopped.load(Ordering::SeqCst) { return Ok(()); }
                remote_instance::poll_remote_instance(&oauth, session.origin.clone()).await;
                token = oauth.capture_access_token(&session.origin);
            }
            let token = token.ok_or(())?;
            if token != validated_token {
                tokio::select! {
                    biased;
                    _ = session.wake.notified() => return Ok(()),
                    verified = verify_account(&client, &session.origin, &token, &account_id) => verified?,
                }
                validated_token = token.clone();
            }
            let poll = client.get(format!("{endpoint}/commands")).bearer_auth(&token)
                .header("X-Lumiverse-Capture-Lease", &registration.transport_token);
            let response: Commands = tokio::select! {
                biased;
                _ = session.wake.notified() => return Ok(()),
                response = async { bounded_json(poll.send().await.map_err(|_| ())?, 32 * 1024).await } => response?,
            };
            if response.commands.len() > 16 { return Err(()); }
            for command in response.commands {
                match command {
                    Command::Cancel { request_id } => {
                        if pending.as_ref().is_some_and(|active| active.request.request_id == request_id) {
                            let active = pending.take().unwrap();
                            active.active.store(false, Ordering::SeqCst);
                            platform::cancel(app, &request_id);
                        }
                    },
                    Command::Capture(request) => {
                        if pending.is_some() { return Err(()); }
                        if let Err(outcome) = request.validate(capabilities, now_ms()) {
                            eprintln!("[Lumiverse capture] request rejected before picker: {outcome}");
                            upload(&client, &endpoint, &token, &registration.transport_token, &request, Err(outcome)).await?;
                        } else if !prompt_budget.allow(now_ms()) {
                            eprintln!("[Lumiverse capture] native prompt cooldown or budget exceeded");
                            upload(&client, &endpoint, &token, &registration.transport_token, &request, Err("denied")).await?;
                        } else {
                            let active = Arc::new(AtomicBool::new(true));
                            let receiver = platform::begin(app, &request, &session.origin, &account, active.clone());
                            pending = Some(Pending { request, active, receiver });
                        }
                    },
                }
            }
            if let Some(active) = pending.as_mut() {
                if active.request.expires_at <= now_ms() {
                    active.active.store(false, Ordering::SeqCst);
                    platform::cancel(app, &active.request.request_id);
                    pending = None;
                } else {
                    match active.receiver.try_recv() {
                        Ok(media) => {
                            eprintln!("[Lumiverse capture] native result: {}", media.as_ref().map(|_| "approved").unwrap_or_else(|outcome| *outcome));
                            let finished = pending.take().unwrap();
                            if session.stopped.load(Ordering::SeqCst) { return Ok(()); }
                            tokio::select! {
                                biased;
                                _ = session.wake.notified() => return Ok(()),
                                result = upload(&client, &endpoint, &token, &registration.transport_token, &finished.request, media) => result?,
                            }
                        },
                        Err(oneshot::error::TryRecvError::Closed) => return Err(()),
                        Err(oneshot::error::TryRecvError::Empty) => {},
                    }
                }
            }
            tokio::select! {
                biased;
                _ = session.wake.notified() => return Ok(()),
                _ = tokio::time::sleep(Duration::from_secs(1)) => {},
            }
        }
    }.await;
    if let Some(active) = pending {
        active.active.store(false, Ordering::SeqCst);
        platform::cancel(app, &active.request.request_id);
    }
    let _ = client
        .delete(&endpoint)
        .bearer_auth(validated_token)
        .header("X-Lumiverse-Capture-Lease", registration.transport_token)
        .send()
        .await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> CaptureRequest {
        serde_json::from_value(serde_json::json!({
            "requestId":uuid::Uuid::new_v4().to_string(),
            "extension":{"id":"extension-id","identifier":"test","name":"Test"},
            "purpose":"Describe this screen","kind":"image",
            "destination":{"connectionId":"connection-id","provider":"google","model":"gemini","endpointOrigin":"provider-default"},
            "maxBytes":IMAGE_BYTES,"maxPixels":MAX_PIXELS,"expiresAt":110_000
        })).unwrap()
    }

    #[test]
    fn rejects_expiry_and_oversized_limits() {
        let caps = Capabilities {
            image: true,
            video: true,
            replay: false,
        };
        let mut capture = request();
        assert!(capture.validate(caps, 100_000).is_ok());
        capture.max_bytes = IMAGE_BYTES + 1;
        assert!(capture.validate(caps, 100_000).is_err());
        capture.max_bytes = IMAGE_BYTES;
        assert!(capture.validate(caps, 110_000).is_err());
        capture.expires_at = 230_001;
        assert!(capture.validate(caps, 100_000).is_err());
        capture.expires_at = 110_000;
        capture.max_pixels = MAX_PIXELS + 1;
        assert!(capture.validate(caps, 100_000).is_err());
    }

    #[test]
    fn picker_consent_names_the_one_shot_destination_and_capture_limits() {
        let capture = request();
        let summary = capture.consent_summary("https://instance.example", "Alice");
        assert!(summary.contains("Test → google · gemini"));
        assert!(summary.contains("provider-default"));
        assert!(summary.contains("https://instance.example · Alice"));
        assert!(summary.contains("Screenshot"));
        let consent = capture.consent_text("https://instance.example", "Alice");
        assert!(consent.contains("Selecting a source authorizes this one capture"));
        assert!(consent.contains("No capture starts before source selection"));
        assert!(consent.contains("Review Before Sending pauses release"));
        let mut video = capture;
        video.kind = "video".into();
        video.mode = Some("record".into());
        video.duration_seconds = Some(3);
        assert!(video
            .consent_summary("https://instance.example", "Alice")
            .contains("3s video · no audio"));
    }

    #[test]
    fn rejects_replay_and_unbounded_video() {
        let caps = Capabilities {
            image: true,
            video: true,
            replay: false,
        };
        let mut capture = request();
        capture.kind = "video".into();
        capture.mode = Some("record".into());
        capture.duration_seconds = Some(30);
        capture.max_bytes = VIDEO_BYTES;
        assert!(capture.validate(caps, 100_000).is_ok());
        capture.mode = Some("replay".into());
        assert_eq!(capture.validate(caps, 100_000), Err("unsupported"));
        capture.mode = Some("record".into());
        capture.duration_seconds = Some(31);
        assert!(capture.validate(caps, 100_000).is_err());
        capture.duration_seconds = Some(0);
        assert!(capture.validate(caps, 100_000).is_err());
        capture.duration_seconds = Some(1);
        assert!(capture
            .validate(
                Capabilities {
                    video: false,
                    ..caps
                },
                100_000
            )
            .is_err());
    }

    #[test]
    fn rejects_identity_spoofing_control_characters() {
        assert!(!safe_label("Extension\nProvider: trusted", 120));
        assert!(!safe_label("trusted\u{202e}evil", 120));
        assert!(!safe_label("", 120));
        assert!(safe_label("A genuine extension", 120));
    }

    #[test]
    fn bundled_host_check_accepts_default_root_urls() {
        let native_url = Url::parse("tauri://localhost").unwrap();
        assert_eq!(native_url.path(), "");
        assert!(trusted_url(&native_url));
        assert!(trusted_url(&Url::parse("tauri://localhost/").unwrap()));
        assert!(trusted_url(&Url::parse("http://tauri.localhost").unwrap()));
        assert!(trusted_url(&Url::parse("https://tauri.localhost").unwrap()));
    }

    #[test]
    fn bundled_host_check_rejects_remote_and_unrelated_pages() {
        assert!(trusted_url(
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(trusted_url(
            &Url::parse("https://tauri.localhost/").unwrap()
        ));
        assert!(!trusted_url(
            &Url::parse("https://example.com/index.html").unwrap()
        ));
        assert!(!trusted_url(
            &Url::parse("tauri://localhost/custom-url.html").unwrap()
        ));
        assert!(!trusted_url(&Url::parse("http://localhost:1431/").unwrap()));
        assert!(!trusted_url(
            &Url::parse("tauri://localhost/?extension=evil").unwrap()
        ));
        assert!(!trusted_url(
            &Url::parse("tauri://localhost?extension=evil").unwrap()
        ));
        assert!(!trusted_url(
            &Url::parse("tauri://localhost#extension=evil").unwrap()
        ));
        assert!(!trusted_url(&Url::parse("tauri://untrusted").unwrap()));
    }

    #[test]
    fn command_envelope_matches_the_worker_broker_protocol() {
        let mut value = serde_json::json!({
            "requestId":uuid::Uuid::new_v4().to_string(),
            "extension":{"id":"extension-id","identifier":"test","name":"Test"},
            "purpose":"Describe this screen","kind":"image","type":"capture",
            "destination":{"connectionId":"connection-id","provider":"google","model":"gemini","endpointOrigin":"provider-default"},
            "maxBytes":IMAGE_BYTES,"maxPixels":MAX_PIXELS,"expiresAt":110_000
        });
        let command: Command = serde_json::from_value(value.clone()).unwrap();
        let Command::Capture(capture) = command else {
            panic!("expected capture request")
        };
        assert!(capture
            .validate(
                Capabilities {
                    image: true,
                    video: true,
                    replay: false
                },
                100_000
            )
            .is_ok());
        value = serde_json::json!({"type":"cancel","requestId":capture.request_id});
        let Command::Cancel { request_id } = serde_json::from_value::<Command>(value).unwrap()
        else {
            panic!("expected cancel request")
        };
        assert_eq!(request_id, capture.request_id);
    }

    #[test]
    fn native_prompt_budget_is_bounded_and_enforces_a_cooldown() {
        let mut budget = PromptBudget::default();
        assert!(budget.allow(100_000));
        assert!(!budget.allow(109_999));
        for attempt in 1..6 {
            assert!(budget.allow(100_000 + attempt * 10_000));
        }
        assert!(!budget.allow(160_000));
        assert!(budget.allow(400_000));
        assert!(budget.recent.len() <= 6);
    }

    #[test]
    fn native_control_responses_are_bounded_and_require_success() {
        tauri::async_runtime::block_on(async {
            let oversized = tauri::http::Response::builder()
                .status(200)
                .header("Content-Length", "2")
                .body(vec![b' '; 4097])
                .unwrap();
            assert!(bounded_json::<serde_json::Value>(oversized.into(), 4096)
                .await
                .is_err());
            let denied = tauri::http::Response::builder()
                .status(401)
                .body(b"{}".to_vec())
                .unwrap();
            assert!(bounded_json::<serde_json::Value>(denied.into(), 4096)
                .await
                .is_err());
            let valid = tauri::http::Response::builder()
                .status(200)
                .body(b"{\"commands\":[]}".to_vec())
                .unwrap();
            assert!(bounded_json::<Commands>(valid.into(), 4096)
                .await
                .unwrap()
                .commands
                .is_empty());
        });
    }

    #[test]
    fn refreshed_tokens_cannot_switch_the_capture_account() {
        let mut principal = NativePrincipal {
            account: NativeAccount {
                id: "account-id".into(),
                name: "Owner".into(),
            },
        };
        assert!(principal.matches("account-id"));
        assert!(!principal.matches("other-account"));
        principal.account.name = "Owner\u{202e}spoof".into();
        assert!(!principal.matches("account-id"));
    }
}
