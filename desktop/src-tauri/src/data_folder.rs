//! Open the selected local server's storage without starting or configuring it.
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::{AppHandle, WebviewWindow};

#[derive(serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocalServerSource {
    Bundled,
    Checkout,
}

fn checkout_command(repo_dir: &str, bun_path: &str) -> Result<Command, String> {
    if !crate::runner::validate_repo(repo_dir.to_owned()) {
        return Err(
            "Choose an existing Lumiverse checkout under Browser → Instance Connection….".into(),
        );
    }
    // Bun loads the checkout's dotenv files just as it does for the runner.
    // Avoid importing the server: that would initialize its identity/database.
    let mut command = Command::new(bun_path);
    command.current_dir(repo_dir).args([
        "--eval",
        "import { resolve } from 'node:path'; process.stdout.write(JSON.stringify(resolve(process.env.DATA_DIR || './data')));",
    ]);
    Ok(command)
}

fn read_data_directory(mut command: Command) -> Result<PathBuf, String> {
    crate::runner::suppress_console(&mut command);
    let output = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("Could not determine the Lumiverse data folder: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Could not determine the Lumiverse data folder: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let path: String = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Invalid data folder response: {error}"))?;
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("The Lumiverse data folder must be an absolute path.".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn open_lumiverse_data_folder(
    app: AppHandle,
    window: WebviewWindow,
    source: LocalServerSource,
    repo_dir: Option<String>,
    bun_path: Option<String>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Opening local data belongs to the tray window.".into());
    }
    let launch_app = app.clone();
    let path = tauri::async_runtime::spawn_blocking(move || {
        let command = match source {
            LocalServerSource::Bundled => {
                let mut command = crate::bundled_server::command(&app)?;
                command.arg("--print-data-dir");
                command
            }
            LocalServerSource::Checkout => checkout_command(
                repo_dir
                    .as_deref()
                    .ok_or("No Lumiverse checkout configured.")?,
                bun_path
                    .as_deref()
                    .ok_or("Bun was not found for the selected checkout.")?,
            )?,
        };
        let path = read_data_directory(command)?;
        // A fresh instance has no data yet. Create only the empty directory so
        // users can copy their old instance before the first server start.
        std::fs::create_dir_all(&path)
            .map_err(|error| format!("Could not access the Lumiverse data folder: {error}"))?;
        Ok::<_, String>(path)
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::external_launch::open_path(&launch_app, &path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Checkout(PathBuf);
    impl Checkout {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("lumiverse-data-folder-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(root.join("scripts")).unwrap();
            // The query must never load the runner or initialize the server.
            std::fs::write(
                root.join("scripts/runner.ts"),
                "throw new Error('must not run');",
            )
            .unwrap();
            Self(root.canonicalize().unwrap())
        }
        fn command(&self) -> Command {
            let bun = crate::runner::resolve_bun().expect("Checkout data folder tests require Bun");
            let mut command = checkout_command(self.0.to_str().unwrap(), &bun).unwrap();
            command
                .env_remove("DATA_DIR")
                .env_remove("BUN_OPTIONS")
                .env("NODE_ENV", "test");
            command
        }
    }
    impl Drop for Checkout {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn resolves_checkout_defaults_and_dotenv_without_initializing_data() {
        let checkout = Checkout::new();
        assert_eq!(
            read_data_directory(checkout.command()).unwrap(),
            checkout.0.join("data")
        );
        std::fs::write(
            checkout.0.join(".env"),
            "DATA_DIR=\"archives/Old Lumiverse Δ\"\n",
        )
        .unwrap();
        assert_eq!(
            read_data_directory(checkout.command()).unwrap(),
            checkout.0.join("archives/Old Lumiverse Δ")
        );
        assert!(!checkout.0.join("data").exists());
        assert!(!checkout.0.join("archives").exists());
    }

    #[test]
    fn checkout_environment_overrides_dotenv() {
        let checkout = Checkout::new();
        std::fs::write(checkout.0.join(".env"), "DATA_DIR=dotenv-data\n").unwrap();
        let mut command = checkout.command();
        command.env("DATA_DIR", "external-data");
        assert_eq!(
            read_data_directory(command).unwrap(),
            checkout.0.join("external-data")
        );
    }

    #[test]
    fn rejects_a_missing_checkout_before_running_bun() {
        let root = std::env::temp_dir().join(format!("lumiverse-missing-{}", uuid::Uuid::new_v4()));
        assert!(checkout_command(root.to_str().unwrap(), "missing-bun").is_err());
        assert!(!root.exists());
    }
}
