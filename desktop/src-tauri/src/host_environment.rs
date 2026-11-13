//! Restore only the external child's environment; never change GTK's runtime.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]
use std::{
    collections::BTreeMap,
    ffi::OsString,
    path::{Path, PathBuf},
    sync::OnceLock,
};

pub const HOST_KEYS: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE",
    "GTK_IM_MODULE_FILE",
    "GIO_MODULE_DIR",
    "GIO_EXTRA_MODULES",
    "GSETTINGS_SCHEMA_DIR",
    "GST_PLUGIN_PATH",
    "GST_PLUGIN_PATH_1_0",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "GST_PLUGIN_SCANNER",
    "GST_PLUGIN_SCANNER_1_0",
    "GST_REGISTRY",
    "GST_REGISTRY_1_0",
    "WEBKIT_EXEC_PATH",
    "WEBKIT_INJECTED_BUNDLE_PATH",
    "GDK_BACKEND",
    "__NV_DISABLE_EXPLICIT_SYNC",
    "WEBKIT_DISABLE_DMABUF_RENDERER",
    "WEBKIT_DISABLE_COMPOSITING_MODE",
    "LIBGL_ALWAYS_SOFTWARE",
    "GALLIUM_DRIVER",
];
pub type Environment = BTreeMap<OsString, OsString>;
static ORIGINAL: OnceLock<Environment> = OnceLock::new();

pub fn capture() {
    let _ = ORIGINAL.set(std::env::vars_os().collect());
}
pub fn for_child() -> Environment {
    match ORIGINAL.get() {
        Some(env) => child_environment(env),
        None => child_environment(&std::env::vars_os().collect()),
    }
}

pub fn original_value(env: &Environment, key: &str) -> Option<OsString> {
    if env
        .get(std::ffi::OsStr::new("LUMIVERSE_HOST_ENV_CAPTURED"))
        .is_some_and(|v| v == "1")
    {
        return (env
            .get(std::ffi::OsStr::new(&format!("LUMIVERSE_HOST_{key}_SET")))
            .is_some_and(|v| v == "1"))
        .then(|| {
            env.get(std::ffi::OsStr::new(&format!("LUMIVERSE_HOST_{key}")))
                .cloned()
                .unwrap_or_default()
        });
    }
    env.get(std::ffi::OsStr::new(key)).cloned()
}

pub fn child_environment(env: &Environment) -> Environment {
    let mut child = env.clone();
    let captured = env
        .get(std::ffi::OsStr::new("LUMIVERSE_HOST_ENV_CAPTURED"))
        .is_some_and(|v| v == "1");
    let appdir = env.get(std::ffi::OsStr::new("APPDIR")).map(PathBuf::from);
    if captured {
        for key in HOST_KEYS {
            child.remove(std::ffi::OsStr::new(key));
            if let Some(value) = original_value(env, key) {
                child.insert((*key).into(), value);
            }
        }
    } else if let Some(appdir) = &appdir {
        // Compatibility with old/extracted launchers: remove only AppDir path
        // components. Preserve user paths and desktop/session configuration.
        for key in HOST_KEYS.iter().filter(|key| {
            !matches!(
                **key,
                "GDK_BACKEND"
                    | "__NV_DISABLE_EXPLICIT_SYNC"
                    | "WEBKIT_DISABLE_DMABUF_RENDERER"
                    | "WEBKIT_DISABLE_COMPOSITING_MODE"
                    | "LIBGL_ALWAYS_SOFTWARE"
                    | "GALLIUM_DRIVER"
            )
        }) {
            if let Some(value) = child.get(std::ffi::OsStr::new(key)).cloned() {
                let paths: Vec<_> = std::env::split_paths(&value)
                    .filter(|path| !path.starts_with(appdir))
                    .collect();
                child.remove(std::ffi::OsStr::new(key));
                if !paths.is_empty() {
                    if let Ok(value) = std::env::join_paths(paths) {
                        child.insert((*key).into(), value);
                    }
                }
            }
        }
        // LD_PRELOAD also permits whitespace-separated entries.
        if let Some(value) = child.get(std::ffi::OsStr::new("LD_PRELOAD")).cloned() {
            let value = value
                .to_string_lossy()
                .split_whitespace()
                .filter(|entry| !Path::new(entry).starts_with(appdir))
                .collect::<Vec<_>>()
                .join(" ");
            child.remove(std::ffi::OsStr::new("LD_PRELOAD"));
            if !value.is_empty() {
                child.insert("LD_PRELOAD".into(), value.into());
            }
        }
    }
    child.retain(|key, _| {
        !key.to_string_lossy().starts_with("LUMIVERSE_HOST_")
            && !matches!(key.to_str(), Some("APPDIR" | "APPIMAGE" | "ARGV0" | "OWD"))
    });
    child
}

#[cfg(unix)]
pub fn launcher(env: &Environment) -> Result<PathBuf, String> {
    use std::os::unix::fs::PermissionsExt;

    let path = env
        .get(std::ffi::OsStr::new("PATH"))
        .cloned()
        .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".into());
    for directory in std::env::split_paths(&path).filter(|path| path.is_absolute()) {
        let candidate = directory.join("xdg-open");
        if candidate
            .metadata()
            .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        {
            return Ok(candidate);
        }
    }
    Err("No host xdg-open launcher was found. Install your desktop's URL handler or use the sign-in link manually.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn env(values: &[(&str, &str)]) -> Environment {
        values
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }
    #[test]
    fn restores_unset_empty_and_user_values_without_touching_session() {
        let input = env(&[
            ("LUMIVERSE_HOST_ENV_CAPTURED", "1"),
            ("LUMIVERSE_HOST_PATH_SET", "1"),
            ("LUMIVERSE_HOST_PATH", "/home/test/with spaces:/usr/bin"),
            ("PATH", "/mount/usr/bin:/usr/bin"),
            ("LUMIVERSE_HOST_LD_PRELOAD_SET", "1"),
            ("LUMIVERSE_HOST_LD_PRELOAD", ""),
            ("LD_LIBRARY_PATH", "/mount/usr/lib"),
            ("__NV_DISABLE_EXPLICIT_SYNC", "1"),
            ("GTK_PATH", "/mount/gtk"),
            ("DBUS_SESSION_BUS_ADDRESS", "session"),
            ("WAYLAND_DISPLAY", "wayland-0"),
            ("APPDIR", "/mount"),
        ]);
        let child = child_environment(&input);
        assert_eq!(
            child.get(std::ffi::OsStr::new("PATH")).unwrap(),
            "/home/test/with spaces:/usr/bin"
        );
        assert_eq!(child.get(std::ffi::OsStr::new("LD_PRELOAD")).unwrap(), "");
        assert!(!child.contains_key(std::ffi::OsStr::new("LD_LIBRARY_PATH")));
        assert!(!child.contains_key(std::ffi::OsStr::new("GTK_PATH")));
        assert!(!child.contains_key(std::ffi::OsStr::new("__NV_DISABLE_EXPLICIT_SYNC")));
        assert_eq!(
            child.get(std::ffi::OsStr::new("WAYLAND_DISPLAY")).unwrap(),
            "wayland-0"
        );
        assert_eq!(
            input.get(std::ffi::OsStr::new("GTK_PATH")).unwrap(),
            "/mount/gtk"
        );
        assert!(!child
            .keys()
            .any(|k| k.to_string_lossy().starts_with("LUMIVERSE_HOST_")));
    }
    #[test]
    fn old_launcher_removes_only_bundle_paths() {
        let child = child_environment(&env(&[
            ("APPDIR", "/mounted app"),
            ("PATH", "/mounted app/usr/bin:/home/user/bin:/usr/bin"),
            ("LD_LIBRARY_PATH", "/mounted app/usr/lib:/opt/user/lib"),
            ("XDG_CURRENT_DESKTOP", "KDE"),
        ]));
        assert_eq!(
            child.get(std::ffi::OsStr::new("PATH")).unwrap(),
            "/home/user/bin:/usr/bin"
        );
        assert_eq!(
            child.get(std::ffi::OsStr::new("LD_LIBRARY_PATH")).unwrap(),
            "/opt/user/lib"
        );
    }
}
