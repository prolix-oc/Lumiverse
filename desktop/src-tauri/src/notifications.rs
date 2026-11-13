//! Durable native-notification enrollment for the hidden desktop tray host.
//!
//! The WebView's cookies are intentionally not part of this path. A per-install
//! device ID and revocable destination credential live in Tauri's app config
//! directory, which remains stable when the application bundle is rebuilt.

use std::{
    io::Cursor,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::{SinkExt, StreamExt};
use image::{ImageFormat, ImageReader};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};
use tokio::time::{interval_at, sleep, timeout, Instant as TokioInstant, MissedTickBehavior};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Error as WebSocketError, Message},
};

const DEVICE_FILE: &str = "desktop_notification_device.json";
const ENROLLMENT_FILE: &str = "desktop_notification_enrollment.json";
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(75);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_RECONNECT_DELAY: Duration = Duration::from_secs(30);
const MAX_NOTIFICATION_FRAME_BYTES: usize = 64 * 1024;
const NOTIFICATION_MEDIA_CACHE_DIR: &str = "desktop-notification-media";
const NOTIFICATION_MEDIA_FETCH_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_NOTIFICATION_MEDIA_BYTES: usize = 8 * 1024 * 1024;
const MAX_NOTIFICATION_MEDIA_DIMENSION: u32 = 8_192;
const MAX_NOTIFICATION_MEDIA_PIXELS: u64 = 32_000_000;
const MAX_NOTIFICATION_OUTPUT_DIMENSION: u32 = 1_200;
const MAX_NOTIFICATION_OUTPUT_BYTES: usize = 12 * 1024 * 1024;
const MAX_CACHED_NOTIFICATION_MEDIA: usize = 64;
const MAX_CACHED_NOTIFICATION_MEDIA_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopNotificationDeviceIdentity {
    device_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationEnrollment {
    device_id: String,
    destination_id: String,
    credential: String,
    server_instance_id: String,
    server_origin: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDesktopNotificationEnrollment {
    device_id: String,
    destination_id: String,
    credential: String,
    server_instance_id: String,
    server_origin: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationEnrollmentSummary {
    destination_id: String,
    server_instance_id: String,
    server_origin: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationDeviceState {
    device_id: String,
    enrollment: Option<DesktopNotificationEnrollmentSummary>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationPayload {
    title: String,
    body: String,
    tag: Option<String>,
    icon: Option<String>,
    image: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTransportInfo {
    server_instance_id: String,
}

#[derive(Deserialize)]
struct DesktopTicketResponse {
    ticket: String,
}

#[derive(Deserialize)]
struct DesktopNotificationMessage {
    event: Option<String>,
    payload: Option<serde_json::Value>,
    timestamp: Option<u64>,
}

#[derive(Default)]
struct DesktopNotificationTransportInner {
    generation: u64,
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    phase: DesktopNotificationTransportPhase,
    destination_id: Option<String>,
    server_origin: Option<String>,
    last_error: Option<String>,
    connected_at: Option<u64>,
    last_received_at: Option<u64>,
    last_notification_at: Option<u64>,
}

#[derive(Default)]
pub struct DesktopNotificationTransportState {
    inner: Mutex<DesktopNotificationTransportInner>,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "snake_case")]
enum DesktopNotificationTransportPhase {
    #[default]
    NotEnrolled,
    Connecting,
    Connected,
    Retrying,
    Blocked,
    Stopped,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationTransportStatus {
    /// Increment when the frontend contract changes incompatibly.
    transport_version: u8,
    state: DesktopNotificationTransportPhase,
    destination_id: Option<String>,
    server_origin: Option<String>,
    last_error: Option<String>,
    connected_at: Option<u64>,
    last_received_at: Option<u64>,
    last_notification_at: Option<u64>,
}

enum ConnectionError {
    Transient(String),
    Permanent(String),
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn update_transport_state(
    app: &AppHandle,
    generation: u64,
    update: impl FnOnce(&mut DesktopNotificationTransportInner),
) {
    let state = app.state::<DesktopNotificationTransportState>();
    let mut inner = state.inner.lock().unwrap();
    if inner.generation == generation {
        update(&mut inner);
    }
}

fn app_config_file(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(name))
}

fn write_private_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    let contents = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(temporary, path).map_err(|error| error.to_string())
    }
    #[cfg(windows)]
    {
        // Windows rename does not replace an existing destination. Keep a
        // recoverable prior copy so a failed rotation cannot strand this
        // install without its durable identity or enrollment.
        let backup = path.with_extension("json.bak");
        if path.exists() {
            if backup.exists() {
                std::fs::remove_file(&backup).map_err(|error| error.to_string())?;
            }
            std::fs::rename(path, &backup).map_err(|error| error.to_string())?;
        }
        match std::fs::rename(&temporary, path) {
            Ok(()) => {
                if backup.exists() {
                    let _ = std::fs::remove_file(backup);
                }
                Ok(())
            }
            Err(error) => {
                if backup.exists() {
                    let _ = std::fs::rename(backup, path);
                }
                Err(error.to_string())
            }
        }
    }
}

fn load_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    std::fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice(&contents).ok())
        .or_else(|| {
            let backup = path.with_extension("json.bak");
            std::fs::read(backup)
                .ok()
                .and_then(|contents| serde_json::from_slice(&contents).ok())
        })
}

fn device_identity(app: &AppHandle) -> Result<DesktopNotificationDeviceIdentity, String> {
    let path = app_config_file(app, DEVICE_FILE)?;
    if let Some(identity) = load_json::<DesktopNotificationDeviceIdentity>(&path) {
        if valid_device_id(&identity.device_id) {
            return Ok(identity);
        }
    }

    let identity = DesktopNotificationDeviceIdentity {
        device_id: uuid::Uuid::new_v4().simple().to_string(),
    };
    write_private_json(&path, &identity)?;
    Ok(identity)
}

fn load_enrollment(app: &AppHandle) -> Result<Option<DesktopNotificationEnrollment>, String> {
    let path = app_config_file(app, ENROLLMENT_FILE)?;
    Ok(load_json(&path))
}

fn valid_device_id(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn permission_name(state: PermissionState) -> &'static str {
    match state {
        PermissionState::Granted => "granted",
        PermissionState::Denied => "denied",
        PermissionState::Prompt | PermissionState::PromptWithRationale => "default",
    }
}

fn normalized_base_url(value: &str) -> Result<tauri::Url, String> {
    let parsed: tauri::Url = value
        .parse()
        .map_err(|_| "Invalid notification server URL")?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Notification server URL must be an HTTP(S) origin".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if parsed.scheme() != "https" && !loopback {
        return Err("Remote desktop notification servers must use HTTPS".into());
    }
    let origin = parsed.origin().ascii_serialization();
    origin
        .parse()
        .map_err(|_| "Invalid notification server origin".into())
}

#[tauri::command]
pub fn desktop_notification_device(
    app: AppHandle,
) -> Result<DesktopNotificationDeviceState, String> {
    let identity = device_identity(&app)?;
    let enrollment = load_enrollment(&app)?.map(|value| DesktopNotificationEnrollmentSummary {
        destination_id: value.destination_id,
        server_instance_id: value.server_instance_id,
        server_origin: value.server_origin,
    });
    Ok(DesktopNotificationDeviceState {
        device_id: identity.device_id,
        enrollment,
    })
}

/// Read-only health for the native, WebView-independent delivery supervisor.
/// Older companion builds do not expose this command, which intentionally lets
/// a remotely hosted frontend detect that it must not claim native delivery is
/// ready after an independently deployed frontend update.
#[tauri::command]
pub fn desktop_notification_transport_status(app: AppHandle) -> DesktopNotificationTransportStatus {
    let state = app.state::<DesktopNotificationTransportState>();
    let inner = state.inner.lock().unwrap();
    DesktopNotificationTransportStatus {
        transport_version: 1,
        state: inner.phase,
        destination_id: inner.destination_id.clone(),
        server_origin: inner.server_origin.clone(),
        last_error: inner.last_error.clone(),
        connected_at: inner.connected_at,
        last_received_at: inner.last_received_at,
        last_notification_at: inner.last_notification_at,
    }
}

#[tauri::command]
pub fn desktop_notification_permission(app: AppHandle, request: bool) -> Result<String, String> {
    let notifications = app.notification();
    let mut state = notifications
        .permission_state()
        .map_err(|error| error.to_string())?;
    if request
        && matches!(
            state,
            PermissionState::Prompt | PermissionState::PromptWithRationale
        )
    {
        state = notifications
            .request_permission()
            .map_err(|error| error.to_string())?;
    }
    Ok(permission_name(state).into())
}

#[tauri::command]
pub fn save_desktop_notification_enrollment(
    app: AppHandle,
    enrollment: SaveDesktopNotificationEnrollment,
) -> Result<(), String> {
    let identity = device_identity(&app)?;
    if enrollment.device_id != identity.device_id || !valid_device_id(&enrollment.device_id) {
        return Err("Desktop notification device identity does not match this install".into());
    }
    if !valid_identifier(&enrollment.destination_id)
        || !valid_identifier(&enrollment.server_instance_id)
        || !enrollment.credential.starts_with("lvd_")
        || enrollment.credential.len() > 160
    {
        return Err("Invalid desktop notification enrollment".into());
    }
    let server_origin = normalized_base_url(&enrollment.server_origin)?
        .origin()
        .ascii_serialization();

    let stored = DesktopNotificationEnrollment {
        device_id: enrollment.device_id,
        destination_id: enrollment.destination_id,
        credential: enrollment.credential,
        server_instance_id: enrollment.server_instance_id,
        server_origin,
    };
    let path = app_config_file(&app, ENROLLMENT_FILE)?;
    write_private_json(&path, &stored)?;
    restart_desktop_notification_transport(&app)
}

#[tauri::command]
pub fn clear_desktop_notification_enrollment(
    app: AppHandle,
    destination_id: Option<String>,
) -> Result<bool, String> {
    let Some(enrollment) = load_enrollment(&app)? else {
        return Ok(false);
    };
    if destination_id
        .as_deref()
        .is_some_and(|id| id != enrollment.destination_id)
    {
        return Ok(false);
    }
    let path = app_config_file(&app, ENROLLMENT_FILE)?;
    if path.exists() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    stop_desktop_notification_transport(&app);
    let state = app.state::<DesktopNotificationTransportState>();
    let mut inner = state.inner.lock().unwrap();
    inner.phase = DesktopNotificationTransportPhase::NotEnrolled;
    inner.destination_id = None;
    inner.server_origin = None;
    inner.last_error = None;
    inner.connected_at = None;
    inner.last_received_at = None;
    inner.last_notification_at = None;
    Ok(true)
}

/// Exchange the private on-disk credential for a short-lived, notification-only
/// WebSocket URL. This runs inside the native supervisor; neither the durable
/// credential nor the one-use ticket enters a WebView.
async fn notification_websocket_url(
    enrollment: &DesktopNotificationEnrollment,
) -> Result<String, ConnectionError> {
    let mut base =
        normalized_base_url(&enrollment.server_origin).map_err(ConnectionError::Permanent)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| ConnectionError::Transient(error.to_string()))?;

    let info_url = base
        .join("/api/desktop-notifications/v1/info")
        .map_err(|error| ConnectionError::Permanent(error.to_string()))?;
    let info_response = client.get(info_url).send().await.map_err(|error| {
        ConnectionError::Transient(format!("Could not reach notification server: {error}"))
    })?;
    if !info_response.status().is_success() {
        return Err(ConnectionError::Transient(format!(
            "Notification server identity check failed ({})",
            info_response.status()
        )));
    }
    let info: DesktopTransportInfo = info_response.json().await.map_err(|error| {
        ConnectionError::Transient(format!("Invalid notification server identity: {error}"))
    })?;
    if info.server_instance_id != enrollment.server_instance_id {
        return Err(ConnectionError::Permanent(
            "Desktop notification enrollment belongs to a different server instance".into(),
        ));
    }

    let ticket_url = base
        .join("/api/desktop-notifications/v1/ticket")
        .map_err(|error| ConnectionError::Permanent(error.to_string()))?;
    let ticket_response = client
        .post(ticket_url)
        .bearer_auth(&enrollment.credential)
        .send()
        .await
        .map_err(|error| {
            ConnectionError::Transient(format!("Could not request notification ticket: {error}"))
        })?;
    if !ticket_response.status().is_success() {
        return Err(
            if ticket_response.status() == reqwest::StatusCode::UNAUTHORIZED {
                ConnectionError::Permanent(
                    "Desktop notification enrollment is no longer valid".into(),
                )
            } else {
                ConnectionError::Transient(format!(
                    "Notification ticket request failed ({})",
                    ticket_response.status()
                ))
            },
        );
    }
    let ticket: DesktopTicketResponse = ticket_response.json().await.map_err(|error| {
        ConnectionError::Transient(format!("Invalid notification ticket response: {error}"))
    })?;

    let websocket_scheme = if base.scheme() == "https" {
        "wss"
    } else {
        "ws"
    };
    base.set_scheme(websocket_scheme).map_err(|_| {
        ConnectionError::Permanent("Could not build notification WebSocket URL".into())
    })?;
    base.set_path("/api/ws");
    base.set_query(None);
    base.query_pairs_mut()
        .append_pair("notificationTicket", &ticket.ticket);

    Ok(base.into())
}

fn validate_desktop_notification_payload(
    payload: &DesktopNotificationPayload,
) -> Result<(), String> {
    let title = payload.title.trim();
    let body = payload.body.trim();
    if title.is_empty() || title.chars().count() > 100 || body.chars().count() > 500 {
        return Err("Invalid desktop notification payload".into());
    }
    if payload.tag.as_deref().is_some_and(|tag| tag.len() > 160) {
        return Err("Invalid desktop notification tag".into());
    }
    Ok(())
}

fn notification_media_reference(payload: &DesktopNotificationPayload) -> Option<&str> {
    payload
        .image
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            payload
                .icon
                .as_deref()
                .filter(|value| !value.trim().is_empty())
        })
}

fn notification_media_url(server_origin: &str, reference: &str) -> Result<tauri::Url, String> {
    if reference.len() > 2_048
        || !reference.starts_with('/')
        || reference.starts_with("//")
        || reference.contains('\\')
        || reference.contains('#')
    {
        return Err("Notification media must be a same-server relative URL".into());
    }

    let base = normalized_base_url(server_origin)?;
    let media_url = base
        .join(reference)
        .map_err(|_| "Invalid notification media URL")?;
    if media_url.origin() != base.origin()
        || !media_url.username().is_empty()
        || media_url.password().is_some()
    {
        return Err("Notification media must use the enrolled server origin".into());
    }
    Ok(media_url)
}

fn notification_media_proxy_url(
    enrollment: &DesktopNotificationEnrollment,
    reference: &str,
) -> Result<tauri::Url, String> {
    let mut url = normalized_base_url(&enrollment.server_origin)?;
    url.set_path("/api/desktop-notifications/v1/media");
    url.set_query(None);
    url.query_pairs_mut().append_pair("path", reference);
    Ok(url)
}

fn notification_media_requires_proxy(reference: &str) -> bool {
    let path = reference.split('?').next().unwrap_or_default();
    let segments: Vec<_> = path.trim_matches('/').split('/').collect();
    matches!(
        segments.as_slice(),
        ["api", "v1", "characters", _, "avatar"] | ["api", "v1", "images", _]
    )
}

fn supported_notification_media_content_type(value: Option<&reqwest::header::HeaderValue>) -> bool {
    let Some(value) = value.and_then(|header| header.to_str().ok()) else {
        return false;
    };
    matches!(
        value
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp" | "application/octet-stream"
    )
}

async fn read_notification_media_response(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "Notification media request failed ({})",
            response.status()
        ));
    }
    if !supported_notification_media_content_type(
        response.headers().get(reqwest::header::CONTENT_TYPE),
    ) {
        return Err("Notification media response was not a supported image".into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_NOTIFICATION_MEDIA_BYTES as u64)
    {
        return Err("Notification media exceeded the download limit".into());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|error| format!("Could not download notification media: {error}"))?;
        if bytes.len().saturating_add(chunk.len()) > MAX_NOTIFICATION_MEDIA_BYTES {
            return Err("Notification media exceeded the download limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        return Err("Notification media response was empty".into());
    }
    Ok(bytes)
}

async fn download_notification_media(
    enrollment: &DesktopNotificationEnrollment,
    reference: &str,
) -> Result<Vec<u8>, String> {
    let direct_url = notification_media_url(&enrollment.server_origin, reference)?;
    let client = reqwest::Client::builder()
        .timeout(NOTIFICATION_MEDIA_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| error.to_string())?;
    let response = if notification_media_requires_proxy(reference) {
        // Browser-session-protected assets (for example, character avatars)
        // use the notification-only media resolver. The durable destination
        // credential is sent only to that narrowly scoped endpoint.
        let proxy_url = notification_media_proxy_url(enrollment, reference)?;
        client
            .get(proxy_url)
            .bearer_auth(&enrollment.credential)
            .send()
            .await
            .map_err(|error| format!("Could not fetch protected notification media: {error}"))?
    } else {
        client
            .get(direct_url)
            .send()
            .await
            .map_err(|error| format!("Could not fetch notification media: {error}"))?
    };

    read_notification_media_response(response).await
}

fn normalize_notification_media(bytes: &[u8]) -> Result<Vec<u8>, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| format!("Could not identify notification image: {error}"))?;
    let Some(format) = reader.format() else {
        return Err("Notification media had an unknown image format".into());
    };
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP
    ) {
        return Err("Notification media used an unsupported image format".into());
    }

    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_NOTIFICATION_MEDIA_DIMENSION);
    limits.max_image_height = Some(MAX_NOTIFICATION_MEDIA_DIMENSION);
    limits.max_alloc = Some(160 * 1024 * 1024);

    let mut dimensions_reader = ImageReader::new(Cursor::new(bytes));
    dimensions_reader.set_format(format);
    dimensions_reader.limits(limits.clone());
    let (width, height) = dimensions_reader
        .into_dimensions()
        .map_err(|error| format!("Could not read notification image dimensions: {error}"))?;
    if width == 0
        || height == 0
        || u64::from(width).saturating_mul(u64::from(height)) > MAX_NOTIFICATION_MEDIA_PIXELS
    {
        return Err("Notification image dimensions exceeded the safety limit".into());
    }

    let mut decode_reader = ImageReader::new(Cursor::new(bytes));
    decode_reader.set_format(format);
    decode_reader.limits(limits);
    let decoded = decode_reader
        .decode()
        .map_err(|error| format!("Could not decode notification image: {error}"))?;
    let normalized = if width > MAX_NOTIFICATION_OUTPUT_DIMENSION
        || height > MAX_NOTIFICATION_OUTPUT_DIMENSION
    {
        decoded.thumbnail(
            MAX_NOTIFICATION_OUTPUT_DIMENSION,
            MAX_NOTIFICATION_OUTPUT_DIMENSION,
        )
    } else {
        decoded
    };

    let mut output = Cursor::new(Vec::new());
    normalized
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| format!("Could not normalize notification image: {error}"))?;
    let output = output.into_inner();
    if output.len() > MAX_NOTIFICATION_OUTPUT_BYTES {
        return Err("Normalized notification image exceeded the cache limit".into());
    }
    Ok(output)
}

fn notification_media_cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?
        .join(NOTIFICATION_MEDIA_CACHE_DIR);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(dir)
}

fn prune_notification_media_cache(dir: &PathBuf, keep: &PathBuf) {
    let Ok(read_dir) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = read_dir
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path == *keep || path.extension().and_then(|value| value.to_str()) != Some("png") {
                return None;
            }
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((modified, path))
        })
        .collect();
    entries.sort_by_key(|entry| std::cmp::Reverse(entry.0));
    let now = SystemTime::now();
    let retained_other_files = MAX_CACHED_NOTIFICATION_MEDIA.saturating_sub(1);
    for (index, (modified, path)) in entries.into_iter().enumerate() {
        let expired = now
            .duration_since(modified)
            .is_ok_and(|age| age > MAX_CACHED_NOTIFICATION_MEDIA_AGE);
        if expired || index >= retained_other_files {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn cache_notification_media(app: &AppHandle, bytes: &[u8]) -> Result<PathBuf, String> {
    let dir = notification_media_cache_dir(app)?;
    let digest = format!("{:x}", Sha256::digest(bytes));
    let path = dir.join(format!("{digest}.png"));
    if !path.exists() {
        let temporary = dir.join(format!("{digest}.{}.tmp", uuid::Uuid::new_v4().simple()));
        std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        if let Err(error) = std::fs::rename(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            if !path.exists() {
                return Err(error.to_string());
            }
        }
    }
    prune_notification_media_cache(&dir, &path);
    Ok(path)
}

async fn prepare_notification_media(
    app: AppHandle,
    enrollment: DesktopNotificationEnrollment,
    reference: String,
) -> Result<PathBuf, String> {
    let downloaded = download_notification_media(&enrollment, &reference).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let normalized = normalize_notification_media(&downloaded)?;
        cache_notification_media(&app, &normalized)
    })
    .await
    .map_err(|error| format!("Notification media worker failed: {error}"))?
}

fn show_desktop_notification(
    _app: AppHandle,
    payload: DesktopNotificationPayload,
    media_path: Option<PathBuf>,
) -> Result<(), String> {
    validate_desktop_notification_payload(&payload)?;
    let title = payload.title.trim();
    let body = payload.body.trim();

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let identifier = _app.config().identifier.clone();
    #[cfg(target_os = "macos")]
    {
        let _ = notify_rust::set_application(if tauri::is_dev() {
            "com.apple.Terminal"
        } else {
            &identifier
        });
    }

    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body).auto_icon();
    if let Some(path) = media_path.as_ref() {
        notification.image_path(path.to_string_lossy().as_ref());
    }
    #[cfg(target_os = "windows")]
    {
        let installed = std::env::current_exe()
            .ok()
            .and_then(|path| path.parent().map(PathBuf::from))
            .is_some_and(|directory| {
                let directory = directory.to_string_lossy();
                let debug_suffix = format!(
                    "{separator}target{separator}debug",
                    separator = std::path::MAIN_SEPARATOR
                );
                let release_suffix = format!(
                    "{separator}target{separator}release",
                    separator = std::path::MAIN_SEPARATOR
                );
                !directory.ends_with(&debug_suffix) && !directory.ends_with(&release_suffix)
            });
        if installed {
            notification.app_id(&identifier);
        }
    }

    notification
        .show()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn present_desktop_notification(
    app: AppHandle,
    enrollment: DesktopNotificationEnrollment,
    generation: u64,
    payload: DesktopNotificationPayload,
) {
    if let Err(error) = validate_desktop_notification_payload(&payload) {
        eprintln!("[desktop-notification] presentation failed: {error}");
        update_transport_state(&app, generation, |inner| {
            inner.last_error = Some(format!("Notification presentation failed: {error}"));
        });
        return;
    }

    let media_path = if let Some(reference) = notification_media_reference(&payload) {
        match prepare_notification_media(app.clone(), enrollment, reference.to_string()).await {
            Ok(path) => Some(path),
            Err(error) => {
                // Rich media is optional. Never hold back a useful text
                // notification because its image is unavailable or invalid.
                eprintln!("[desktop-notification] media unavailable: {error}");
                None
            }
        }
    } else {
        None
    };

    if !transport_is_current(&app, generation) {
        return;
    }
    let notification_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        show_desktop_notification(notification_app, payload, media_path)
    })
    .await;
    let error = match result {
        Ok(Ok(())) => return,
        Ok(Err(error)) => error,
        Err(error) => format!("Notification presentation worker failed: {error}"),
    };
    eprintln!("[desktop-notification] presentation failed: {error}");
    update_transport_state(&app, generation, |inner| {
        inner.last_error = Some(format!("Notification presentation failed: {error}"));
    });
}

fn transport_is_current(app: &AppHandle, generation: u64) -> bool {
    app.state::<DesktopNotificationTransportState>()
        .inner
        .lock()
        .unwrap()
        .generation
        == generation
}

fn handle_notification_message(
    app: &AppHandle,
    enrollment: &DesktopNotificationEnrollment,
    generation: u64,
    text: &str,
) -> Result<(), String> {
    if text.len() > MAX_NOTIFICATION_FRAME_BYTES {
        return Err("Notification transport received an oversized frame".into());
    }
    let Ok(message) = serde_json::from_str::<DesktopNotificationMessage>(text) else {
        // Application-level pong frames intentionally do not have an event.
        return Ok(());
    };

    match message.event.as_deref() {
        Some("AUTH_ERROR") => Err("Notification transport authorization was rejected".into()),
        Some("DESKTOP_NOTIFICATION") => {
            let Some(payload_value) = message.payload else {
                return Err("Notification transport received an empty payload".into());
            };
            let payload = serde_json::from_value::<DesktopNotificationPayload>(payload_value)
                .map_err(|_| "Notification transport received an invalid payload")?;
            if !transport_is_current(app, generation) {
                return Ok(());
            }
            if let Some(sent_at) = message.timestamp {
                let received_at = unix_time_ms();
                let delay = received_at.saturating_sub(sent_at);
                if delay >= 5_000 {
                    eprintln!("[desktop-notification] transport delay was {delay}ms");
                }
            }
            update_transport_state(app, generation, |inner| {
                inner.last_notification_at = Some(unix_time_ms());
            });
            let notification_app = app.clone();
            let notification_enrollment = enrollment.clone();
            tauri::async_runtime::spawn(async move {
                present_desktop_notification(
                    notification_app,
                    notification_enrollment,
                    generation,
                    payload,
                )
                .await;
            });
            Ok(())
        }
        _ => Ok(()),
    }
}

async fn run_notification_session(
    app: &AppHandle,
    enrollment: &DesktopNotificationEnrollment,
    generation: u64,
    websocket_url: &str,
) -> Result<(), String> {
    let connection = timeout(CONNECT_TIMEOUT, connect_async(websocket_url))
        .await
        .map_err(|_| "Notification WebSocket connection timed out".to_string())?
        .map_err(|error| format!("Notification WebSocket connection failed: {error}"))?;
    let (mut socket, _) = connection;
    let connected_at = unix_time_ms();
    update_transport_state(app, generation, |inner| {
        inner.phase = DesktopNotificationTransportPhase::Connected;
        inner.last_error = None;
        inner.connected_at = Some(connected_at);
        inner.last_received_at = Some(connected_at);
    });
    let mut heartbeat = interval_at(TokioInstant::now() + HEARTBEAT_INTERVAL, HEARTBEAT_INTERVAL);
    heartbeat.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut last_received = Instant::now();

    loop {
        if !transport_is_current(app, generation) {
            let _ = socket.close(None).await;
            return Ok(());
        }

        tokio::select! {
            _ = heartbeat.tick() => {
                if last_received.elapsed() > HEARTBEAT_TIMEOUT {
                    return Err("Notification WebSocket heartbeat timed out".into());
                }
                socket
                    .send(Message::Text(r#"{"type":"ping"}"#.into()))
                    .await
                    .map_err(|error| format!("Notification WebSocket heartbeat failed: {error}"))?;
            }
            incoming = socket.next() => {
                let Some(incoming) = incoming else {
                    return Err("Notification WebSocket closed without a close frame".into());
                };
                let message = incoming
                    .map_err(|error: WebSocketError| format!("Notification WebSocket read failed: {error}"))?;
                last_received = Instant::now();
                update_transport_state(app, generation, |inner| {
                    inner.last_received_at = Some(unix_time_ms());
                });
                match message {
                    Message::Text(text) => {
                        handle_notification_message(app, enrollment, generation, text.as_ref())?;
                    }
                    Message::Binary(bytes) => {
                        if bytes.len() > MAX_NOTIFICATION_FRAME_BYTES {
                            return Err("Notification transport received an oversized frame".into());
                        }
                        if let Ok(text) = std::str::from_utf8(bytes.as_ref()) {
                            handle_notification_message(app, enrollment, generation, text)?;
                        }
                    }
                    Message::Ping(payload) => {
                        socket
                            .send(Message::Pong(payload))
                            .await
                            .map_err(|error| format!("Notification WebSocket pong failed: {error}"))?;
                    }
                    Message::Close(frame) => {
                        return Err(format!("Notification WebSocket closed: {frame:?}"));
                    }
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

fn reconnect_delay(attempt: u32) -> Duration {
    let multiplier = 1_u64 << attempt.min(4);
    Duration::from_secs((2 * multiplier).min(MAX_RECONNECT_DELAY.as_secs()))
}

async fn run_notification_supervisor(
    app: AppHandle,
    enrollment: DesktopNotificationEnrollment,
    generation: u64,
) {
    let mut retry_attempt = 0_u32;

    while transport_is_current(&app, generation) {
        let websocket_url = match notification_websocket_url(&enrollment).await {
            Ok(url) => url,
            Err(ConnectionError::Permanent(error)) => {
                eprintln!("[desktop-notification] transport stopped: {error}");
                update_transport_state(&app, generation, |inner| {
                    inner.phase = DesktopNotificationTransportPhase::Blocked;
                    inner.last_error = Some(error);
                });
                break;
            }
            Err(ConnectionError::Transient(error)) => {
                eprintln!("[desktop-notification] connection attempt failed: {error}");
                update_transport_state(&app, generation, |inner| {
                    inner.phase = DesktopNotificationTransportPhase::Retrying;
                    inner.last_error = Some(error);
                });
                let delay = reconnect_delay(retry_attempt);
                retry_attempt = retry_attempt.saturating_add(1);
                sleep(delay).await;
                update_transport_state(&app, generation, |inner| {
                    inner.phase = DesktopNotificationTransportPhase::Connecting;
                });
                continue;
            }
        };

        let connected_at = Instant::now();
        if let Err(error) =
            run_notification_session(&app, &enrollment, generation, &websocket_url).await
        {
            if transport_is_current(&app, generation) {
                eprintln!("[desktop-notification] session ended: {error}");
                update_transport_state(&app, generation, |inner| {
                    inner.phase = DesktopNotificationTransportPhase::Retrying;
                    inner.last_error = Some(error);
                });
            }
        }
        if !transport_is_current(&app, generation) {
            break;
        }
        if connected_at.elapsed() >= HEARTBEAT_INTERVAL {
            retry_attempt = 0;
        }
        let delay = reconnect_delay(retry_attempt);
        retry_attempt = retry_attempt.saturating_add(1);
        sleep(delay).await;
        update_transport_state(&app, generation, |inner| {
            inner.phase = DesktopNotificationTransportPhase::Connecting;
        });
    }

    let state = app.state::<DesktopNotificationTransportState>();
    let mut inner = state.inner.lock().unwrap();
    if inner.generation == generation {
        inner.task = None;
    }
}

/// Restart delivery from the durable enrollment. The task is owned by Tauri's
/// Tokio runtime and therefore remains active when every WebView is hidden.
pub fn restart_desktop_notification_transport(app: &AppHandle) -> Result<(), String> {
    let enrollment = load_enrollment(app)?;
    let state = app.state::<DesktopNotificationTransportState>();
    let mut inner = state.inner.lock().unwrap();
    inner.generation = inner.generation.wrapping_add(1);
    if let Some(task) = inner.task.take() {
        task.abort();
    }
    let Some(enrollment) = enrollment else {
        inner.phase = DesktopNotificationTransportPhase::NotEnrolled;
        inner.destination_id = None;
        inner.server_origin = None;
        inner.last_error = None;
        inner.connected_at = None;
        inner.last_received_at = None;
        inner.last_notification_at = None;
        return Ok(());
    };

    let generation = inner.generation;
    inner.phase = DesktopNotificationTransportPhase::Connecting;
    inner.destination_id = Some(enrollment.destination_id.clone());
    inner.server_origin = Some(enrollment.server_origin.clone());
    inner.last_error = None;
    inner.connected_at = None;
    inner.last_received_at = None;
    let transport_app = app.clone();
    inner.task = Some(tauri::async_runtime::spawn(async move {
        run_notification_supervisor(transport_app, enrollment, generation).await;
    }));
    Ok(())
}

pub fn stop_desktop_notification_transport(app: &AppHandle) {
    let state = app.state::<DesktopNotificationTransportState>();
    let mut inner = state.inner.lock().unwrap();
    inner.generation = inner.generation.wrapping_add(1);
    if let Some(task) = inner.task.take() {
        task.abort();
    }
    inner.phase = DesktopNotificationTransportPhase::Stopped;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_backoff_is_bounded() {
        let delays: Vec<_> = (0..8).map(reconnect_delay).collect();
        assert_eq!(
            delays,
            vec![
                Duration::from_secs(2),
                Duration::from_secs(4),
                Duration::from_secs(8),
                Duration::from_secs(16),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
                Duration::from_secs(30),
            ]
        );
    }

    #[test]
    fn native_notification_frame_deserializes() {
        let message: DesktopNotificationMessage = serde_json::from_str(
            r#"{"event":"DESKTOP_NOTIFICATION","payload":{"title":"Ready","body":"Generation complete","tag":"generation-chat","icon":"/api/v1/characters/char-1/avatar?size=sm","image":"/api/v1/image-gen/results/image-1?size=lg"},"timestamp":42}"#,
        )
        .unwrap();
        let payload: DesktopNotificationPayload =
            serde_json::from_value(message.payload.unwrap()).unwrap();
        assert_eq!(message.event.as_deref(), Some("DESKTOP_NOTIFICATION"));
        assert_eq!(message.timestamp, Some(42));
        assert_eq!(payload.title, "Ready");
        assert_eq!(payload.body, "Generation complete");
        assert_eq!(payload.tag.as_deref(), Some("generation-chat"));
        assert_eq!(
            payload.icon.as_deref(),
            Some("/api/v1/characters/char-1/avatar?size=sm")
        );
        assert_eq!(
            payload.image.as_deref(),
            Some("/api/v1/image-gen/results/image-1?size=lg")
        );
        assert_eq!(
            notification_media_reference(&payload),
            Some("/api/v1/image-gen/results/image-1?size=lg")
        );
    }

    #[test]
    fn notification_media_urls_are_limited_to_the_enrolled_origin() {
        let url = notification_media_url(
            "https://lumiverse.example",
            "/api/v1/image-gen/results/image-1?size=lg",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://lumiverse.example/api/v1/image-gen/results/image-1?size=lg"
        );

        for invalid in [
            "https://attacker.example/image.png",
            "//attacker.example/image.png",
            "/image.png#fragment",
            "/image\\evil.png",
            "image.png",
        ] {
            assert!(
                notification_media_url("https://lumiverse.example", invalid).is_err(),
                "accepted invalid media reference {invalid}"
            );
        }
        assert!(notification_media_requires_proxy(
            "/api/v1/characters/char-1/avatar?size=sm"
        ));
        assert!(notification_media_requires_proxy(
            "/api/v1/images/image-1?size=lg"
        ));
        assert!(!notification_media_requires_proxy(
            "/api/v1/image-gen/results/image-1?size=lg"
        ));
    }

    #[test]
    fn notification_media_is_normalized_to_png() {
        let source = image::DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            2,
            2,
            image::Rgba([12, 34, 56, 255]),
        ));
        let mut encoded = Cursor::new(Vec::new());
        source.write_to(&mut encoded, ImageFormat::WebP).unwrap();

        let normalized = normalize_notification_media(&encoded.into_inner()).unwrap();
        assert_eq!(&normalized[..8], b"\x89PNG\r\n\x1a\n");
        let decoded = image::load_from_memory(&normalized).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (2, 2));
        assert!(normalize_notification_media(b"<svg></svg>").is_err());
    }

    #[test]
    fn authorization_error_frame_deserializes_without_notification_fields() {
        let message: DesktopNotificationMessage = serde_json::from_str(
            r#"{"event":"AUTH_ERROR","payload":{"message":"expired"},"timestamp":42}"#,
        )
        .unwrap();
        assert_eq!(message.event.as_deref(), Some("AUTH_ERROR"));
        assert_eq!(message.timestamp, Some(42));
    }
}
