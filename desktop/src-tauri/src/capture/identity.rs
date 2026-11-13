//! An opaque per-instance/account identity, independent of short-lived leases.
use sha2::{Digest, Sha256};
use std::{fs, io::Write};
use tauri::{AppHandle, Manager};

fn scoped_key(secret: &str, origin: &str, account: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(secret, origin, account)).unwrap())
    )
}

pub fn device_key(app: &AppHandle, origin: &str, account: &str) -> Result<String, String> {
    let directory = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let path = directory.join("capture-identity-v1");
    Ok(scoped_key(&load_secret(&path)?, origin, account))
}

fn load_secret(path: &std::path::Path) -> Result<String, String> {
    let secret = match fs::metadata(path) {
        Ok(meta) if meta.len() == 64 => fs::read_to_string(path).map_err(|e| e.to_string())?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let secret = format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            );
            let mut options = fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(path).map_err(|e| e.to_string())?;
            file.write_all(secret.as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| e.to_string())?;
            secret
        }
        _ => return Err("The persistent capture identity is unavailable".into()),
    };
    if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("The persistent capture identity is invalid".into());
    }
    Ok(secret)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identity_is_stable_but_not_shared_between_instances_accounts_or_installs() {
        let key = scoped_key("secret", "https://instance", "alice");
        assert_eq!(key, scoped_key("secret", "https://instance", "alice"));
        assert_ne!(key, scoped_key("secret", "https://other", "alice"));
        assert_ne!(key, scoped_key("secret", "https://instance", "bob"));
        assert_ne!(key, scoped_key("new-install", "https://instance", "alice"));
    }

    #[test]
    fn reopening_the_native_identity_file_preserves_identity_and_corruption_never_rotates_it_silently(
    ) {
        let directory =
            std::env::temp_dir().join(format!("lumiverse-identity-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("identity");
        let first = load_secret(&path).unwrap();
        assert_eq!(first, load_secret(&path).unwrap());
        fs::write(&path, "corrupt").unwrap();
        assert!(load_secret(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "corrupt");
        fs::remove_dir_all(directory).unwrap();
    }
}
