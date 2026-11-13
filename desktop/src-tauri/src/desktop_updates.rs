//! Signed application updates. Only the trusted tray can select/check/install.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

const FEEDS: &str = "https://github.com/prolix-oc/Lumiverse/releases/download/desktop-updates";
const RESUME_FILE: &str = "desktop-update-resume.json";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Stable,
    Nightly,
}
impl UpdateChannel {
    fn name(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }
    fn accepts(self, version: &semver::Version) -> bool {
        match self {
            Self::Stable => version.pre.is_empty(),
            Self::Nightly => version.pre.as_str().starts_with("nightly."),
        }
    }
}
struct PendingUpdate {
    update: Update,
    channel: UpdateChannel,
    bytes: Option<Vec<u8>>,
}
#[derive(Default)]
pub struct DesktopUpdatesState {
    busy: AtomicBool,
    pending: Mutex<Option<PendingUpdate>>,
}
struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl DesktopUpdatesState {
    fn acquire(&self) -> Result<Busy<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "A desktop update operation is already in progress.")?;
        Ok(Busy(&self.busy))
    }
}
fn require_tray(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Desktop updates belong to the local tray host.".into());
    }
    Ok(())
}
fn configured_public_key(config: &tauri::Config) -> Option<&str> {
    config
        .plugins
        .0
        .get("updater")?
        .get("pubkey")?
        .as_str()
        .filter(|key| !key.trim().is_empty())
}
fn unavailable_reason(app: &AppHandle) -> Option<&'static str> {
    if cfg!(debug_assertions) || app.state::<crate::profile::DesktopProfile>().isolated {
        return Some("Updates are disabled for debug builds and isolated profiles.");
    }
    if crate::bundled_server::binary().is_none() {
        return Some("This desktop build does not include the bundled server.");
    }
    if configured_public_key(app.config()).is_none() {
        return Some("This build has no updater signing public key.");
    }
    #[cfg(target_os = "linux")]
    if app.env().appimage.is_none() {
        return Some("Install the AppImage to use desktop updates on Linux.");
    }
    None
}
fn require_available(app: &AppHandle) -> Result<(), String> {
    unavailable_reason(app).map_or(Ok(()), |reason| Err(reason.to_owned()))
}
#[tauri::command]
pub fn desktop_update_info(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    require_tray(&window)?;
    let version = &app.package_info().version;
    let channel = if version.pre.as_str().starts_with("nightly.") {
        UpdateChannel::Nightly
    } else {
        UpdateChannel::Stable
    };
    Ok(
        json!({ "enabled": unavailable_reason(&app).is_none(), "reason": unavailable_reason(&app), "version": version.to_string(), "defaultChannel": channel }),
    )
}
#[tauri::command]
pub async fn desktop_update_check(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopUpdatesState>,
    channel: UpdateChannel,
) -> Result<Value, String> {
    require_tray(&window)?;
    require_available(&app)?;
    let _busy = state.acquire()?;
    state.pending.lock().unwrap().take();
    let endpoint = format!("{FEEDS}/{}.json", channel.name())
        .parse()
        .map_err(|error| format!("Invalid update endpoint: {error}"))?;
    let mut update = app
        .updater_builder()
        // Inherit the key from the embedded plugin config on every platform.
        // Private builders supply it via --config, without a key environment variable.
        .endpoints(vec![endpoint])
        .map_err(|error| error.to_string())?
        .timeout(Duration::from_secs(30))
        .version_comparator(move |current, release| {
            channel.accepts(&release.version) && release.version > current
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    if let Some(ref mut update) = update {
        if update.raw_json["channel"] != channel.name() {
            return Err("The update feed belongs to a different release channel.".into());
        }
        // Large artifacts need a longer timeout than the small feed request.
        update.timeout = Some(Duration::from_secs(30 * 60));
    }
    let result = match &update {
        Some(update) => {
            json!({ "version": update.version, "notes": update.body, "channel": channel })
        }
        None => Value::Null,
    };
    *state.pending.lock().unwrap() = update.map(|update| PendingUpdate {
        update,
        channel,
        bytes: None,
    });
    Ok(result)
}
#[tauri::command]
pub async fn desktop_update_download(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopUpdatesState>,
    version: String,
    channel: UpdateChannel,
) -> Result<(), String> {
    require_tray(&window)?;
    require_available(&app)?;
    let _busy = state.acquire()?;
    let update = {
        let pending = state.pending.lock().unwrap();
        let pending = pending
            .as_ref()
            .ok_or("Check for a desktop update first.")?;
        if pending.update.version != version || pending.channel != channel {
            return Err("The selected update has changed. Check again.".into());
        }
        pending.update.clone()
    };
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now() - Duration::from_secs(1);
    // The plugin verifies the signature before returning any installable bytes.
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                if last_emit.elapsed() >= Duration::from_millis(250) {
                    let _ = app.emit_to(
                        "main",
                        "desktop-update-progress",
                        json!({ "version": version, "downloaded": downloaded, "total": total }),
                    );
                    last_emit = Instant::now();
                }
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    state
        .pending
        .lock()
        .unwrap()
        .as_mut()
        .ok_or("The selected update was cleared.")?
        .bytes = Some(bytes);
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct UpdateResume {
    version: String,
    created_at: u64,
    resume: crate::runner::DesktopUpdateResume,
}
impl UpdateResume {
    fn matches(&self, version: &str, current_time: u64) -> bool {
        self.version == version
            && self.created_at <= current_time
            && current_time - self.created_at < 86_400
    }
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn restore_resume(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let path = app.path().app_local_data_dir()?.join(RESUME_FILE);
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(());
    };
    std::fs::remove_file(&path)?;
    if let Ok(saved) = serde_json::from_slice::<UpdateResume>(&bytes) {
        if saved.matches(&app.package_info().version.to_string(), now()) {
            app.state::<crate::runner::DesktopUpdateResumeState>()
                .set(saved.resume);
        }
    }
    Ok(())
}
#[tauri::command]
pub async fn desktop_update_install(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, DesktopUpdatesState>,
    version: String,
    channel: UpdateChannel,
    resume_server: bool,
    reopen_frontend: bool,
    local_port: Option<u16>,
) -> Result<(), String> {
    require_tray(&window)?;
    require_available(&app)?;
    if local_port == Some(0) {
        return Err("The local server port must be between 1 and 65535.".into());
    }
    let _busy = state.acquire()?;
    let pending = state
        .pending
        .lock()
        .unwrap()
        .take()
        .ok_or("Download an update first.")?;
    if pending.update.version != version || pending.channel != channel {
        return Err("The selected update has changed. Check again.".into());
    }
    let bytes = pending
        .bytes
        .ok_or("The update has not been downloaded and verified.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        let path = folder.join(RESUME_FILE);
        let resume = UpdateResume {
            version,
            created_at: now(),
            resume: crate::runner::DesktopUpdateResume::new(resume_server, reopen_frontend)
                .with_port(local_port),
        };
        std::fs::write(&path, serde_json::to_vec(&resume).unwrap())
            .map_err(|error| error.to_string())?;
        // JS already performed the graceful handshake. Also cover a native
        // call that missed it; externally owned servers are never touched.
        crate::runner::force_stop(&app);
        if let Err(error) = pending.update.install(bytes) {
            let _ = std::fs::remove_file(path);
            return Err(error.to_string());
        }
        app.restart();
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_builder_key_is_available_from_the_embedded_plugin_config() {
        let mut config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(configured_public_key(&config).is_none());
        // Private Linux and Windows builders configure the plugin this way;
        // LUMIVERSE_UPDATER_PUBLIC_KEY is deliberately absent from compilation.
        config
            .plugins
            .0
            .insert("updater".into(), json!({ "pubkey": "release-public-key" }));
        assert_eq!(configured_public_key(&config), Some("release-public-key"));
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config.plugins.0["updater"].clone()).unwrap();
        assert_eq!(
            Some(updater.pubkey.as_str()),
            configured_public_key(&config)
        );
        config
            .plugins
            .0
            .insert("updater".into(), json!({ "pubkey": " \n\t" }));
        assert!(configured_public_key(&config).is_none());
    }
    #[test]
    fn unsigned_development_config_initializes_the_updater_plugin() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater: tauri_plugin_updater::Config =
            serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
        assert!(updater.pubkey.is_empty());
        assert!(updater.endpoints.is_empty());
    }
    #[test]
    fn resume_requires_the_installed_version_and_a_recent_update() {
        let resume = UpdateResume {
            version: "0.3.2".into(),
            created_at: 1_000,
            resume: crate::runner::DesktopUpdateResume::new(false, true).with_port(Some(17860)),
        };
        assert!(resume.matches("0.3.2", 1_001));
        assert!(!resume.matches("0.3.1", 1_001));
        assert!(!resume.matches("0.3.2", 87_400));
        assert!(!resume.matches("0.3.2", 999));
        let saved = serde_json::to_value(&resume).unwrap();
        assert_eq!(
            saved["resume"],
            json!({ "resumeServer": false, "reopenFrontend": true, "localPort": 17860 })
        );
    }
    #[test]
    fn channels_never_cross_or_offer_a_downgrade() {
        let stable = semver::Version::parse("0.3.1").unwrap();
        let next = semver::Version::parse("0.3.2").unwrap();
        let nightly = semver::Version::parse("0.3.2-nightly.20261014.42").unwrap();
        assert!(UpdateChannel::Stable.accepts(&stable));
        assert!(!UpdateChannel::Stable.accepts(&nightly));
        assert!(UpdateChannel::Nightly.accepts(&nightly));
        assert!(!UpdateChannel::Nightly.accepts(&stable));
        assert!(nightly > stable && nightly < next);
        assert!(serde_json::from_str::<UpdateChannel>("\"custom\"").is_err());
    }
    #[test]
    fn concurrent_checks_cannot_replace_a_downloading_update() {
        let state = DesktopUpdatesState::default();
        let guard = state.acquire().unwrap();
        assert!(state.acquire().is_err());
        drop(guard);
        assert!(state.acquire().is_ok());
    }
}
