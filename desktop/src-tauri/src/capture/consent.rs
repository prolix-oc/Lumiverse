//! Native approval records. No WebView API can read or write source identities or grants.
use super::CaptureRequest;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::PathBuf,
};
use tauri::{AppHandle, Manager};

#[derive(Default, Serialize, Deserialize)]
pub struct Records {
    grants: BTreeMap<String, String>,
    paused: BTreeSet<String>,
    #[serde(default)]
    disabled_by_user: bool,
}

#[derive(Default)]
pub struct Store {
    records: Records,
    loaded: bool,
    // A failed explicit disable must still block starts in this process.
    failed: bool,
    generation: u64,
}

#[derive(Clone)]
pub struct Context {
    pub app: AppHandle,
    key: String,
    owner: String,
    pub can_remember: bool,
    generation: u64,
}

fn hash(value: &impl Serialize) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}

#[derive(Clone)]
struct Scope {
    key: String,
    owner: String,
    can_remember: bool,
}

impl Scope {
    fn new(request: &CaptureRequest, origin: &str, account: &str) -> Self {
        let owner = hash(&(
            origin,
            account,
            &request.extension.id,
            &request.extension.identifier,
        ));
        let mut key = hash(&(
            &owner,
            &request.extension.approval_revision,
            &request.kind,
            &request.destination.connection_id,
            &request.destination.revision,
            &request.destination.provider,
            &request.destination.model,
            &request.destination.endpoint_origin,
        ));
        // Preserve existing picker grants, but never reuse them for an explicit display.
        if let Some(display_id) = &request.display_id {
            key = hash(&(key, display_id));
        }
        let valid_revision = |revision: &Option<String>| {
            revision.as_ref().is_some_and(|revision| {
                revision.len() == 64 && revision.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        };
        Self {
            key,
            owner,
            can_remember: valid_revision(&request.extension.approval_revision)
                && valid_revision(&request.destination.revision),
        }
    }
}

impl Records {
    fn disable(&mut self) {
        *self = Self {
            disabled_by_user: true,
            ..Self::default()
        };
    }

    fn source(&self, scope: &Scope) -> Result<Option<String>, &'static str> {
        if self.disabled_by_user || self.paused.contains(&scope.owner) {
            return Err("denied");
        }
        Ok(if scope.can_remember {
            self.grants.get(&scope.key).cloned()
        } else {
            None
        })
    }
}

impl Context {
    /// Read-only discovery. Does not choose a source, prompt, or modify an approval.
    pub fn status(&self) -> (&'static str, Option<String>) {
        let state = self.app.state::<super::DesktopCaptureState>();
        let Ok(mut store) = state.consent.lock() else {
            return ("unavailable", None);
        };
        if store.load(&self.app).is_err() || store.failed || store.generation != self.generation {
            return ("unavailable", None);
        }
        if store.records.disabled_by_user || store.records.paused.contains(&self.owner) {
            return ("paused", None);
        }
        let source = if self.can_remember {
            store.records.grants.get(&self.key).cloned()
        } else {
            None
        };
        (
            if source.is_some() {
                "remembered"
            } else {
                "required"
            },
            source,
        )
    }
    pub fn new(app: &AppHandle, request: &CaptureRequest, origin: &str, account: &str) -> Self {
        let scope = Scope::new(request, origin, account);
        let generation = app
            .state::<super::DesktopCaptureState>()
            .consent
            .lock()
            .map(|store| store.generation)
            .unwrap_or(u64::MAX);
        Self {
            app: app.clone(),
            generation,
            key: scope.key,
            owner: scope.owner,
            can_remember: scope.can_remember,
        }
    }

    pub fn source(&self) -> Result<Option<String>, &'static str> {
        let state = self.app.state::<super::DesktopCaptureState>();
        let mut store = state.consent.lock().map_err(|_| "denied")?;
        store.load(&self.app).map_err(|_| "denied")?;
        if store.failed || store.generation != self.generation {
            return Err("denied");
        }
        store.records.source(&Scope {
            key: self.key.clone(),
            owner: self.owner.clone(),
            can_remember: self.can_remember,
        })
    }

    pub fn remember(&self, source: String) {
        if !self.can_remember || source.is_empty() || source.len() > 4096 {
            return;
        }
        let state = self.app.state::<super::DesktopCaptureState>();
        if let Ok(mut store) = state.consent.lock() {
            if store.load(&self.app).is_err()
                || store.generation != self.generation
                || store.failed
                || store.records.disabled_by_user
                || store.records.paused.contains(&self.owner)
            {
                return;
            }
            if store.records.grants.len() >= 128 && !store.records.grants.contains_key(&self.key) {
                return;
            }
            store.records.grants.insert(self.key.clone(), source);
            if store.save(&self.app).is_err() {
                store.records.grants.remove(&self.key);
            }
        };
    }

    pub fn invalidate(&self) {
        let state = self.app.state::<super::DesktopCaptureState>();
        if let Ok(mut store) = state.consent.lock() {
            if store.generation == self.generation && store.load(&self.app).is_ok() {
                store.records.grants.remove(&self.key);
                if store.save(&self.app).is_err() {
                    store.failed = true;
                }
            }
        };
    }
}

impl Store {
    pub fn disabled_by_user(&mut self, app: &AppHandle) -> Result<bool, String> {
        self.load(app)?;
        Ok(self.records.disabled_by_user)
    }

    pub fn disable(&mut self, app: &AppHandle) -> Result<(), String> {
        self.generation = self.generation.wrapping_add(1);
        self.records.disable();
        self.loaded = true;
        let result = self.save(app);
        self.failed = result.is_err();
        result
    }

    fn path(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_local_data_dir()
            .map(|path| path.join("capture-consent-v1.json"))
            .map_err(|e| e.to_string())
    }

    fn load(&mut self, app: &AppHandle) -> Result<(), String> {
        if self.loaded {
            return Ok(());
        }
        let path = Self::path(app)?;
        self.records = match fs::metadata(&path) {
            Ok(meta) if meta.len() <= 1024 * 1024 => {
                // Corrupt records never grant access. Treat them as needing owner recovery.
                let bytes = fs::read(path).map_err(|e| e.to_string())?;
                serde_json::from_slice(&bytes)
                    .map_err(|_| "Capture approvals need to be reset".to_string())?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Records::default(),
            _ => return Err("Capture approvals are unavailable".into()),
        };
        if self.records.grants.len() > 128
            || self.records.paused.len() > 1024
            || self
                .records
                .grants
                .iter()
                .any(|(key, value)| key.len() != 64 || value.is_empty() || value.len() > 4096)
            || self.records.paused.iter().any(|key| key.len() != 64)
        {
            return Err("Capture approvals are invalid".into());
        }
        self.loaded = true;
        Ok(())
    }

    fn save(&self, app: &AppHandle) -> Result<(), String> {
        use std::io::Write;
        let path = Self::path(app)?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        // Truncation fails closed after a crash: malformed state cannot authorize capture.
        let mut file = options.open(path).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&self.records).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }

    pub fn reset(&mut self, app: &AppHandle, forget: bool) -> Result<(), String> {
        if !forget {
            self.load(app)?;
        }
        self.generation = self.generation.wrapping_add(1);
        if forget {
            self.records = Records::default();
        }
        self.records.paused.clear();
        self.records.disabled_by_user = false;
        self.save(app)?;
        self.failed = false;
        self.loaded = true;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> CaptureRequest {
        serde_json::from_value(serde_json::json!({
            "requestId":uuid::Uuid::new_v4().to_string(),
            "extension":{"id":"installed","identifier":"test","name":"Test","approvalRevision":"a".repeat(64)},
            "purpose":"Describe this screen","kind":"image",
            "destination":{"connectionId":"connection","revision":"b".repeat(64),"provider":"google","model":"vision","endpointOrigin":"https://provider"},
            "maxBytes":8388608,"maxPixels":16777216,"expiresAt":110000
        })).unwrap()
    }

    #[test]
    fn only_the_approved_scope_can_reuse_a_source() {
        let request = request();
        let scope = Scope::new(&request, "https://instance", "alice");
        let mut records = Records::default();
        records
            .grants
            .insert(scope.key.clone(), "native-source".into());
        assert_eq!(
            records.source(&scope).unwrap().as_deref(),
            Some("native-source")
        );
        assert_eq!(
            records
                .source(&Scope::new(&request, "https://other", "alice"))
                .unwrap(),
            None
        );
        assert_eq!(
            records
                .source(&Scope::new(&request, "https://instance", "bob"))
                .unwrap(),
            None
        );
        for changed in ["installation", "kind", "destination", "grant", "endpoint", "display"] {
            let mut request = request.clone();
            match changed {
                "installation" => request.extension.id = "reinstalled".into(),
                "kind" => request.kind = "video".into(),
                "destination" => request.destination.revision = Some("c".repeat(64)),
                "grant" => request.extension.approval_revision = Some("d".repeat(64)),
                "display" => request.display_id = Some("e".repeat(64)),
                _ => request.destination.endpoint_origin = "https://other".into(),
            }
            assert_eq!(
                records
                    .source(&Scope::new(&request, "https://instance", "alice"))
                    .unwrap(),
                None
            );
        }
    }

    #[test]
    fn approving_one_display_never_approves_another_or_the_generic_picker() {
        let mut request = request();
        request.display_id = Some("a".repeat(64));
        let scope = Scope::new(&request, "https://instance", "alice");
        let mut records = Records::default();
        records.grants.insert(scope.key.clone(), "display-a-source".into());
        assert_eq!(records.source(&scope).unwrap().as_deref(), Some("display-a-source"));
        for display_id in [Some("b".repeat(64)), None] {
            request.display_id = display_id;
            assert_eq!(records.source(&Scope::new(&request, "https://instance", "alice")).unwrap(), None);
        }
    }

    #[test]
    fn legacy_pause_survives_serialization_and_blocks_changed_destinations() {
        let mut request = request();
        let scope = Scope::new(&request, "https://instance", "alice");
        let mut records = Records::default();
        records.grants.insert(scope.key.clone(), "source".into());
        records.paused.insert(scope.owner.clone());
        let mut restored: Records =
            serde_json::from_slice(&serde_json::to_vec(&records).unwrap()).unwrap();
        assert!(restored.source(&scope).is_err());
        request.destination.revision = Some("c".repeat(64));
        assert!(restored
            .source(&Scope::new(&request, "https://instance", "alice"))
            .is_err());
        restored.paused.clear();
        assert_eq!(restored.source(&scope).unwrap().as_deref(), Some("source"));
        restored.grants.clear();
        assert_eq!(restored.source(&scope).unwrap(), None);
    }

    #[test]
    fn legacy_or_malformed_revisions_cannot_create_a_remembered_grant() {
        let mut request = request();
        request.extension.approval_revision = None;
        assert!(!Scope::new(&request, "https://instance", "alice").can_remember);
        request.extension.approval_revision = Some("a".repeat(64));
        request.destination.revision = Some("not-a-revision".into());
        assert!(!Scope::new(&request, "https://instance", "alice").can_remember);
        assert!(serde_json::from_str::<Records>("{broken").is_err());
    }

    #[test]
    fn explicit_disable_blocks_every_extension_and_survives_restart() {
        let request = request();
        let scope = Scope::new(&request, "https://instance", "alice");
        let mut records = Records::default();
        records.grants.insert(scope.key.clone(), "source".into());
        records.disable();
        assert!(records.grants.is_empty());
        let restored: Records =
            serde_json::from_slice(&serde_json::to_vec(&records).unwrap()).unwrap();
        assert!(restored.source(&scope).is_err());
        assert!(restored
            .source(&Scope::new(&request, "https://other", "bob"))
            .is_err());
        let legacy: Records = serde_json::from_str(r#"{"grants":{},"paused":[]}"#).unwrap();
        assert!(!legacy.disabled_by_user);
    }
}
