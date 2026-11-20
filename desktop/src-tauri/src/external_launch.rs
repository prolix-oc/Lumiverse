//! One external launch boundary for OAuth, browser links, and local folders.
use tauri::AppHandle;
#[cfg(not(target_os = "linux"))]
use tauri_plugin_opener::OpenerExt;

pub async fn open_url(app: &AppHandle, value: &str) -> Result<(), String> {
    let url = tauri::Url::parse(value).map_err(|_| "Invalid external URL")?;
    if !matches!(url.scheme(), "http" | "https" | "mailto" | "tel")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Unsupported external URL".into());
    }
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux::open_url(value).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        app.opener()
            .open_url(value, None::<String>)
            .map_err(|_| "Could not open the system browser".into())
    }
}

pub async fn open_path(app: &AppHandle, path: &std::path::Path) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        linux::host_launch(path.as_os_str()).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        app.opener()
            .open_path(path.to_string_lossy(), None::<&str>)
            .map_err(|error| format!("Could not open the folder: {error}"))
    }
}

#[tauri::command]
pub async fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    open_url(&app, &url).await
}

#[tauri::command]
pub async fn reveal_desktop_artifact(
    app: AppHandle,
    window: tauri::WebviewWindow,
    path: std::path::PathBuf,
) -> Result<(), String> {
    if window.label() != "main" || !path.is_absolute() {
        return Err("Artifact reveal belongs to the tray.".into());
    }
    #[cfg(target_os = "linux")]
    {
        open_path(&app, path.parent().ok_or("Missing parent folder")?).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        app.opener()
            .reveal_item_in_dir(path)
            .map_err(|_| "Could not reveal the desktop artifact".into())
    }
}

#[cfg(any(target_os = "linux", all(test, unix)))]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod linux {
    use futures_util::StreamExt;
    use std::{collections::HashMap, ffi::OsStr, time::Duration};
    use tokio::{io::AsyncReadExt, time::timeout};
    use zbus::{
        zvariant::{OwnedObjectPath, OwnedValue, Value},
        Connection, Proxy,
    };

    const DESTINATION: &str = "org.freedesktop.portal.Desktop";
    // Dropping a cancelled OAuth future must also close any portal chooser.
    struct RequestGuard(Connection, String);
    impl Drop for RequestGuard {
        fn drop(&mut self) {
            let connection = self.0.clone();
            let path = self.1.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(proxy) = Proxy::new(
                    &connection,
                    DESTINATION,
                    path.as_str(),
                    "org.freedesktop.portal.Request",
                )
                .await
                {
                    let _ =
                        timeout(Duration::from_secs(2), proxy.call::<_, _, ()>("Close", &())).await;
                }
            });
        }
    }

    // None means no request was dispatched and a fallback is safe. Errors
    // after dispatch (including a timeout) never trigger a duplicate browser.
    async fn portal(uri: &str) -> Option<Result<(), String>> {
        let connection = match timeout(Duration::from_secs(2), Connection::session()).await {
            Ok(Ok(c)) => c,
            _ => return None,
        };
        let proxy = match Proxy::new(
            &connection,
            DESTINATION,
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.OpenURI",
        )
        .await
        {
            Ok(p) => p,
            Err(_) => return None,
        };
        let version = timeout(Duration::from_secs(2), proxy.get_property::<u32>("version")).await;
        if !matches!(version, Ok(Ok(_))) {
            return None;
        }
        let sender = connection
            .unique_name()?
            .as_str()
            .trim_start_matches(':')
            .replace('.', "_");
        let token = format!("lumiverse_{}", uuid::Uuid::new_v4().simple());
        let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{token}");
        let request = match Proxy::new(
            &connection,
            DESTINATION,
            path.as_str(),
            "org.freedesktop.portal.Request",
        )
        .await
        {
            Ok(p) => p,
            Err(_) => return None,
        };
        // Subscribe before calling OpenURI; fast responses otherwise get lost.
        let mut responses = match request.receive_signal("Response").await {
            Ok(s) => s,
            Err(_) => return None,
        };
        let _guard = RequestGuard(connection.clone(), path.clone());
        let mut options: HashMap<&str, Value<'_>> = HashMap::new();
        options.insert("handle_token", Value::from(token.as_str()));
        let activation = std::env::var("XDG_ACTIVATION_TOKEN").ok();
        if let Some(value) = activation.as_deref() {
            options.insert("activation_token", Value::from(value));
        }
        let handle = match timeout(Duration::from_secs(5), proxy.call::<_, _, OwnedObjectPath>("OpenURI", &("", uri, options))).await {
            Ok(Ok(handle)) => handle,
            Ok(Err(zbus::Error::MethodError(name, _, _))) if matches!(name.as_str(),
                "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" |
                "org.freedesktop.DBus.Error.UnknownMethod" | "org.freedesktop.portal.Error.NotSupported") => return None,
            _ => return Some(Err("The desktop portal did not confirm browser dispatch. Use the manual sign-in link or retry.".into())),
        };
        if handle.as_str() != path {
            return Some(Err(
                "The desktop portal returned an unexpected request. Use the manual link.".into(),
            ));
        }
        Some(match timeout(Duration::from_secs(30), responses.next()).await {
            Ok(Some(message)) => match message.body().deserialize::<(u32, HashMap<String, OwnedValue>)>() {
                Ok((0, _)) => Ok(()),
                Ok((1, _)) => Err("Browser launch was cancelled. Retry or use the manual sign-in link.".into()),
                _ => Err("The desktop portal could not open the browser. Check your default URL handler or use the manual link.".into()),
            },
            _ => Err("The desktop portal is still waiting. Retry or use the manual sign-in link.".into()),
        })
    }

    pub async fn open_url(uri: &str) -> Result<(), String> {
        match portal(uri).await {
            Some(result) => result,
            None => host_launch(OsStr::new(uri)).await,
        }
    }

    pub async fn host_launch(target: &OsStr) -> Result<(), String> {
        let env = crate::host_environment::for_child();
        host_launch_with(env, target, Duration::from_secs(3)).await
    }

    async fn host_launch_with(
        env: crate::host_environment::Environment,
        target: &OsStr,
        deadline: Duration,
    ) -> Result<(), String> {
        let launcher = crate::host_environment::launcher(&env)?;
        let home = env
            .get(OsStr::new("HOME"))
            .map(std::path::PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_dir())
            .unwrap_or_else(|| "/".into());
        let mut command = tokio::process::Command::new(&launcher);
        let mut child = command
            .arg(target)
            .env_clear()
            .envs(env)
            .current_dir(home)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|_| {
                "Could not start the host URL handler. Check your default browser installation."
                    .to_string()
            })?;
        let mut stderr = child.stderr.take().unwrap();
        let mut reader = tokio::spawn(async move {
            let mut bytes = Vec::new();
            let mut buffer = [0; 1024];
            // Drain without retaining more than 4 KiB. A verbose handler must
            // not block on a full pipe or see SIGPIPE while opening a browser.
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let remaining = 4096_usize.saturating_sub(bytes.len());
                bytes.extend_from_slice(&buffer[..count.min(remaining)]);
            }
            bytes
        });
        let result = match timeout(deadline, child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            Ok(Ok(status)) => {
                let bytes = timeout(Duration::from_millis(100), &mut reader)
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .unwrap_or_default();
                let hint = failure_hint(&bytes);
                Err(format!("The host URL handler exited with {status}. {hint} Check the default browser, or copy the sign-in link into it."))
            }
            Ok(Err(_)) => {
                Err("Could not observe the host URL handler. Use the manual link.".into())
            }
            Err(_) => {
                // Some handlers stay alive with the browser. Dispatch is not
                // proof of a visible browser or completed authorization.
                tauri::async_runtime::spawn(async move {
                    let _ = child.wait().await;
                });
                Ok(())
            }
        };
        // Dropping the task handle detaches the bounded drain, which also
        // covers handlers that fork a browser inheriting stderr.
        eprintln!(
            "[external-launch] host handler {}",
            if result.is_ok() {
                "dispatched; callback may still be pending"
            } else {
                "failed"
            }
        );
        result
    }
    fn failure_hint(stderr: &[u8]) -> &'static str {
        let text = String::from_utf8_lossy(stderr).to_ascii_lowercase();
        // Only fixed hints leave this boundary. Raw stderr can contain OAuth
        // codes, URLs, local usernames and paths in arbitrary encodings.
        if text.contains("symbol lookup error")
            || text.contains("error while loading shared libraries")
        {
            "The browser reported a library loading failure."
        } else if text.contains("not found")
            || text.contains("no method available")
            || text.contains("no application")
        {
            "No working URL handler was reported."
        } else if text.contains("cannot open display") {
            "The browser could not connect to the display."
        } else if text.contains("permission denied") {
            "The browser reported a permission error."
        } else {
            "The launcher did not report a recognized failure category."
        }
    }
    #[cfg(all(test, unix))]
    mod tests {
        use super::*;
        use std::{io::Write, os::unix::fs::PermissionsExt, path::PathBuf};
        struct Host(PathBuf);
        impl Host {
            fn new(script: &str) -> Self {
                let root =
                    std::env::temp_dir().join(format!("lumiverse host {}", uuid::Uuid::new_v4()));
                std::fs::create_dir_all(&root).unwrap();
                let path = root.join("xdg-open");
                // A parallel fork can inherit a writable descriptor even after
                // fs::write closes it here, making exec fail with ETXTBSY. Only
                // the writer subprocess opens the executable, and it exits
                // before any test launches it. See rust-lang/rust#114554.
                let mut writer = std::process::Command::new("/bin/sh")
                    .args(["-c", "cat > \"$1\"", "fixture-writer"])
                    .arg(&path)
                    .stdin(std::process::Stdio::piped())
                    .spawn()
                    .unwrap();
                writer
                    .stdin
                    .take()
                    .unwrap()
                    .write_all(format!("#!/bin/sh\n{script}\n").as_bytes())
                    .unwrap();
                assert!(writer.wait().unwrap().success());
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
                Self(root.canonicalize().unwrap())
            }
            fn environment(&self) -> crate::host_environment::Environment {
                [
                    ("PATH", self.0.as_os_str().to_owned()),
                    ("HOME", self.0.as_os_str().to_owned()),
                    ("WAYLAND_DISPLAY", "wayland-test".into()),
                ]
                .into_iter()
                .map(|(k, v)| (k.into(), v))
                .collect()
            }
        }
        impl Drop for Host {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        #[tokio::test]
        async fn observes_nonzero_exit_without_echoing_sensitive_url_or_stderr() {
            let host = Host::new("echo \"$1 secret-token\" >&2; exit 7");
            let error = host_launch_with(
                host.environment(),
                OsStr::new("https://example.com/?code=private"),
                Duration::from_secs(1),
            )
            .await
            .unwrap_err();
            assert!(error.contains('7'), "{error}");
            assert!(!error.contains("private") && !error.contains("secret-token"));
        }
        #[tokio::test]
        async fn host_launcher_receives_its_environment_and_accessible_working_directory() {
            let host = Host::new("[ \"$PWD\" = \"$HOME\" ] && [ \"$WAYLAND_DISPLAY\" = wayland-test ] && [ \"${APPDIR+x}\" = \"\" ]");
            host_launch_with(
                host.environment(),
                OsStr::new("https://example.com"),
                Duration::from_secs(1),
            )
            .await
            .unwrap();
        }
        #[tokio::test]
        async fn long_lived_browser_does_not_block_dispatch() {
            let host = Host::new("/bin/sleep 0.15");
            host_launch_with(
                host.environment(),
                OsStr::new("https://example.com"),
                Duration::from_millis(20),
            )
            .await
            .unwrap();
        }

        #[tokio::test]
        async fn fresh_launcher_fixtures_execute_during_parallel_process_spawns() {
            use std::sync::{
                atomic::{AtomicBool, Ordering},
                Arc,
            };
            let running = Arc::new(AtomicBool::new(true));
            let workers: Vec<_> = (0..4)
                .map(|_| {
                    let running = running.clone();
                    std::thread::spawn(move || {
                        while running.load(Ordering::Relaxed) {
                            // /bin/true is absent on macOS; use the same
                            // portable shell required by the launcher fixture.
                            assert!(std::process::Command::new("/bin/sh")
                                .args(["-c", "exit 0"])
                                .status()
                                .unwrap()
                                .success());
                        }
                    })
                })
                .collect();
            let mut errors = Vec::new();
            for _ in 0..200 {
                let host = Host::new("exit 7");
                let result = host_launch_with(
                    host.environment(),
                    OsStr::new("https://example.com"),
                    Duration::from_secs(1),
                )
                .await;
                if !matches!(&result, Err(error) if error.contains("exit status: 7")) {
                    errors.push(result);
                }
            }
            running.store(false, Ordering::Relaxed);
            for worker in workers {
                worker.join().unwrap();
            }
            assert!(errors.is_empty(), "fixture launch failures: {errors:?}");
        }
    }
}
