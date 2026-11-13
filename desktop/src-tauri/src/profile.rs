//! Named test profiles isolate files, WebView cookies, credentials, and server data.
#[cfg(any(target_os = "macos", test))]
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{Manager, State, WebviewWindow, WebviewWindowBuilder};

static ACTIVE: OnceLock<DesktopProfile> = OnceLock::new();
static WEBVIEW_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopProfile {
    pub name: Option<String>,
    pub isolated: bool,
    pub identifier: String,
    #[cfg(any(target_os = "macos", test))]
    #[serde(skip)]
    store_identifier: [u8; 16],
}

fn profile_name(args: impl IntoIterator<Item = String>) -> Result<Option<String>, String> {
    let mut args = args.into_iter();
    let mut profile = None;
    while let Some(arg) = args.next() {
        if arg != "--profile" {
            continue;
        }
        let name = args.next().ok_or("--profile requires a name")?;
        if profile.is_some()
            || name.is_empty()
            || name.len() > 48
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        {
            return Err(
                "Use one profile name containing 1–48 lowercase letters, digits, or hyphens."
                    .into(),
            );
        }
        profile = Some(name);
    }
    Ok(profile)
}

pub fn prepare(
    config: &mut tauri::Config,
    args: impl IntoIterator<Item = String>,
) -> Result<DesktopProfile, String> {
    let profile = derive_profile(&config.identifier, profile_name(args)?);
    config.identifier = profile.identifier.clone();
    if profile.isolated {
        for window in &mut config.app.windows {
            #[cfg(target_os = "macos")]
            if mac_custom_store_available() {
                window.data_store_identifier = Some(profile.store_identifier);
            } else {
                window.incognito = true;
            }
            #[cfg(not(target_os = "macos"))]
            let _ = window;
        }
    }
    let _ = ACTIVE.set(profile.clone());
    Ok(profile)
}

fn derive_profile(identifier: &str, name: Option<String>) -> DesktopProfile {
    let identifier = match &name {
        Some(name) => format!("{identifier}.profile.{name}"),
        None => identifier.to_owned(),
    };
    let isolated = name.is_some() || identifier.starts_with("chat.lumiverse.tray.debug");
    #[cfg(any(target_os = "macos", test))]
    let digest = Sha256::digest(identifier.as_bytes());
    DesktopProfile {
        name,
        isolated,
        identifier,
        #[cfg(any(target_os = "macos", test))]
        store_identifier: digest[..16].try_into().unwrap(),
    }
}

pub fn initialize<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if app.state::<DesktopProfile>().isolated {
        WEBVIEW_DIRECTORY
            .set(app.path().app_local_data_dir()?.join("webview"))
            .ok();
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_custom_store_available() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| {
        std::process::Command::new("/usr/bin/sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .and_then(|output| String::from_utf8(output.stdout).ok())
            .and_then(|version| version.trim().split('.').next()?.parse::<u32>().ok())
            .is_some_and(|major| major >= 14)
    })
}

pub fn configure_webview<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    let Some(profile) = ACTIVE.get().filter(|profile| profile.isolated) else {
        return builder;
    };
    #[cfg(target_os = "macos")]
    {
        if mac_custom_store_available() {
            builder.data_store_identifier(profile.store_identifier)
        } else {
            builder.incognito(true)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = profile;
        match WEBVIEW_DIRECTORY.get() {
            Some(path) => builder.data_directory(path.clone()),
            None => builder,
        }
    }
}

#[tauri::command]
pub fn desktop_profile_info(
    window: WebviewWindow,
    state: State<'_, DesktopProfile>,
) -> Result<DesktopProfile, String> {
    if window.label() != "main" {
        return Err("Profile information belongs to the local tray.".into());
    }
    Ok(state.inner().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn production_debug_and_named_profiles_have_distinct_stable_storage() {
        let production = derive_profile("chat.lumiverse.tray", None);
        let debug = derive_profile("chat.lumiverse.tray.debug", None);
        let first = derive_profile("chat.lumiverse.tray.debug", Some("first".into()));
        let second = derive_profile("chat.lumiverse.tray.debug", Some("second".into()));
        assert!(!production.isolated);
        assert_eq!(production.identifier, "chat.lumiverse.tray");
        assert!(debug.isolated && first.isolated && second.isolated);
        assert_eq!(first.identifier, "chat.lumiverse.tray.debug.profile.first");
        for other in [&production, &debug, &second] {
            assert_ne!(first.identifier, other.identifier);
            assert_ne!(first.store_identifier, other.store_identifier);
        }
        assert_eq!(
            first.store_identifier,
            derive_profile("chat.lumiverse.tray.debug", Some("first".into())).store_identifier
        );
    }

    #[test]
    fn named_profiles_are_explicit_and_cannot_escape_their_namespace() {
        assert_eq!(profile_name(Vec::<String>::new()).unwrap(), None);
        assert_eq!(
            profile_name(["--profile".into(), "setup-test-1".into()])
                .unwrap()
                .as_deref(),
            Some("setup-test-1")
        );
        for name in ["../real", "", "default.profile", "UPPER", "space name"] {
            assert!(profile_name(["--profile".into(), name.into()]).is_err());
        }
        assert!(profile_name(["--profile".into()]).is_err());
    }
}
