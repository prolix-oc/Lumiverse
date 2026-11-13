//! Owner-configured actions, never a keyboard listener exposed to extensions.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Chord {
    code: String,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

impl Chord {
    fn shortcut(&self) -> Result<Shortcut, String> {
        let code = self
            .code
            .parse::<Code>()
            .map_err(|_| "Unsupported shortcut key")?;
        let function_key = self.code.strip_prefix('F').and_then(|n| n.parse::<u8>().ok());
        let supported = (self.code.starts_with("Key") && self.code.len() == 4)
            || (self.code.starts_with("Digit") && self.code.len() == 6)
            || function_key.is_some_and(|n| (1..=24).contains(&n))
            || matches!(
                self.code.as_str(),
                "Space"
                    | "Enter"
                    | "ArrowUp"
                    | "ArrowDown"
                    | "ArrowLeft"
                    | "ArrowRight"
                    | "Home"
                    | "End"
                    | "PageUp"
                    | "PageDown"
            );
        let standalone = function_key.is_some_and(|n| (13..=24).contains(&n));
        if !supported || !(self.ctrl || self.alt || self.meta || standalone) {
            return Err("Use F13–F24 alone, or Control, Alt/Option or Command/Super with a letter, number, function or navigation key".into());
        }
        let mut modifiers = Modifiers::empty();
        if self.ctrl {
            modifiers |= Modifiers::CONTROL;
        }
        if self.alt {
            modifiers |= Modifiers::ALT;
        }
        if self.shift {
            modifiers |= Modifiers::SHIFT;
        }
        if self.meta {
            modifiers |= Modifiers::SUPER;
        }
        Ok(Shortcut::new(Some(modifiers), code))
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Scope {
    Focused,
    Global,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    id: String,
    chord: Chord,
    scope: Scope,
    action: String,
    origin: Option<String>,
    account_id: Option<String>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Command {
    id: String,
    label: String,
}

#[derive(Clone, Default, PartialEq, Eq)]
struct Catalog {
    origin: String,
    account: String,
    commands: Vec<Command>,
}

#[derive(Default)]
struct Inner {
    bindings: Vec<Binding>,
    catalog: Catalog,
    pressed: BTreeSet<u32>,
    errors: BTreeMap<String, String>,
    global_approvals: BTreeSet<String>,
    approval_pending: bool,
    editing: bool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    bindings: Vec<Binding>,
    global_approvals: BTreeSet<String>,
}

#[derive(Default)]
pub struct KeybindingsState {
    inner: Mutex<Inner>,
    changes: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    bindings: Vec<Binding>,
    commands: Vec<Command>,
    origin: String,
    account_id: String,
    errors: BTreeMap<String, String>,
    global_available: bool,
    global_enabled: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Trigger {
    binding_id: String,
    command_id: String,
    scope: Scope,
    account_id: String,
}

fn native_action(action: &str) -> bool {
    matches!(
        action,
        "desktop:toggle-window" | "desktop:show-window" | "desktop:reload" | "desktop:stop-capture"
    )
}

fn eligible(binding: &Binding, catalog: &Catalog) -> bool {
    native_action(&binding.action)
        || (binding.origin.as_deref() == Some(&catalog.origin)
            && binding.account_id.as_deref() == Some(&catalog.account)
            && !catalog.account.is_empty()
            && catalog.commands.iter().any(|cmd| cmd.id == binding.action))
}

// Registered OS shortcuts can consume keydown even when the callback ignores it.
// Release them while the focused frontend editor needs to record those keys.
fn global_active(binding: &Binding, inner: &Inner, frontend_focused: bool) -> bool {
    !(inner.editing && frontend_focused)
        && binding.scope == Scope::Global
        && eligible(binding, &inner.catalog)
}

fn visible(binding: &Binding, catalog: &Catalog) -> bool {
    native_action(&binding.action)
        || (binding.origin.as_deref() == Some(&catalog.origin)
            && binding.account_id.as_deref() == Some(&catalog.account))
}

fn approval_key(catalog: &Catalog) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(&catalog.origin, &catalog.account)).unwrap())
    )
}

fn frontend_catalog(inner: &Inner, origin: &str) -> Result<Catalog, String> {
    if inner.catalog.origin != origin || inner.catalog.account.is_empty() {
        return Err("Open and sign in to Lumiverse before configuring key bindings".into());
    }
    Ok(inner.catalog.clone())
}

fn merge_frontend_bindings(
    inner: &Inner,
    catalog: &Catalog,
    bindings: Vec<Binding>,
    command_id: Option<&str>,
) -> Result<Vec<Binding>, String> {
    let bindings = if let Some(action) = command_id {
        if !catalog.commands.iter().any(|command| command.id == action)
            || bindings.iter().any(|binding| binding.action != action)
        {
            return Err("The extension command is unavailable".into());
        }
        let mut replacement: Vec<Binding> = inner
            .bindings
            .iter()
            .filter(|binding| visible(binding, catalog) && binding.action != action)
            .cloned()
            .collect();
        replacement.extend(bindings);
        replacement
    } else {
        bindings
    };
    let allowed = inner.global_approvals.contains(&approval_key(catalog));
    for binding in &bindings {
        if !visible(binding, catalog) {
            return Err("Bindings must belong to the current instance and account".into());
        }
        if binding.scope == Scope::Global
            && !allowed
            && !inner.bindings.iter().any(|saved| saved == binding)
        {
            return Err("Enable global key bindings first".into());
        }
    }
    let mut merged: Vec<Binding> = inner
        .bindings
        .iter()
        .filter(|binding| !visible(binding, catalog))
        .cloned()
        .collect();
    merged.extend(bindings);
    validate(&merged)?;
    Ok(merged)
}

fn validate(bindings: &[Binding]) -> Result<(), String> {
    if bindings.len() > 64 {
        return Err("At most 64 desktop bindings are supported".into());
    }
    let mut ids = BTreeSet::new();
    let mut chords: Vec<(Option<&str>, Option<&str>, u32)> = Vec::new();
    for binding in bindings {
        if uuid::Uuid::parse_str(&binding.id).is_err()
            || !ids.insert(&binding.id)
            || !valid_text(&binding.action, 256)
        {
            return Err("Invalid or duplicate binding".into());
        }
        let shortcut = binding.chord.shortcut()?;
        // Global and focused bindings cannot compete for the same chord in one context.
        if chords.iter().any(|(origin, account, id)| {
            *id == shortcut.id()
                && (origin.is_none()
                    || binding.origin.is_none()
                    || (*origin == binding.origin.as_deref()
                        && *account == binding.account_id.as_deref()))
        }) {
            return Err("Two bindings use the same shortcut for this account".into());
        }
        chords.push((
            binding.origin.as_deref(),
            binding.account_id.as_deref(),
            shortcut.id(),
        ));
        if native_action(&binding.action) {
            if binding.origin.is_some() || binding.account_id.is_some() {
                return Err("Desktop actions do not belong to an account".into());
            }
        } else if binding.origin.as_ref().is_none_or(|s| !valid_text(s, 2048))
            || binding
                .account_id
                .as_ref()
                .is_none_or(|s| !valid_text(s, 128))
        {
            return Err("App commands require an instance and account".into());
        }
    }
    Ok(())
}

fn valid_text(text: &str, limit: usize) -> bool {
    !text.is_empty() && text.len() <= limit && !text.chars().any(char::is_control)
}

fn local_page(window: &WebviewWindow, label: &str, path: &str) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    let bundled = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost"));
    let development = cfg!(debug_assertions)
        && url.scheme() == "http"
        && url.port() == Some(1430)
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"));
    if window.label() != label
        || !(bundled || development)
        || url.path() != path
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Key binding settings require the bundled desktop controls".into());
    }
    Ok(())
}

fn frontend_origin(window: &WebviewWindow) -> Result<String, String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if window.label() != "frontend" || !matches!(url.scheme(), "http" | "https") {
        return Err("Use the primary Lumiverse window".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("keybindings-v1.json"))
        .map_err(|e| e.to_string())
}

// Must be called under changes, but never while holding inner: registration runs on the UI thread.
fn apply(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<KeybindingsState>();
    let frontend_focused = app
        .get_webview_window("frontend")
        .is_some_and(|window| window.is_focused().unwrap_or(false));
    let bindings = {
        let inner = state.inner.lock().unwrap();
        inner
            .bindings
            .iter()
            .filter(|b| global_active(b, &inner, frontend_focused))
            .cloned()
            .collect::<Vec<_>>()
    };
    if !global_available(app) {
        state.inner.lock().unwrap().errors = bindings
            .iter()
            .map(|b| {
                (
                    b.id.clone(),
                    "Global shortcuts are unavailable in this desktop session".into(),
                )
            })
            .collect();
        return Ok(());
    }
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    let mut errors = BTreeMap::new();
    let mut shortcuts = BTreeSet::new();
    for binding in bindings {
        let shortcut = binding.chord.shortcut()?;
        if !shortcuts.insert(shortcut.id()) {
            errors.insert(
                binding.id,
                "Shortcut conflicts with another active binding".into(),
            );
            continue;
        }
        if let Err(error) = app.global_shortcut().register(shortcut) {
            errors.insert(binding.id, format!("Global shortcut unavailable: {error}"));
        }
    }
    let mut inner = state.inner.lock().unwrap();
    inner.pressed.clear();
    inner.errors = errors;
    Ok(())
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    let path = path(app)?;
    let bytes = match fs::metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Ok(meta) if meta.len() <= 256 * 1024 => fs::read(path).map_err(|e| e.to_string())?,
        _ => return Err("Saved key bindings are unavailable".into()),
    };
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Saved {
        Current(Configuration),
        Legacy(Vec<Binding>),
    }
    let configuration = match serde_json::from_slice::<Saved>(&bytes).map_err(|e| e.to_string())? {
        Saved::Current(configuration) => configuration,
        Saved::Legacy(bindings) => Configuration {
            bindings,
            ..Default::default()
        },
    };
    validate(&configuration.bindings)?;
    if configuration.global_approvals.len() > 64
        || configuration
            .global_approvals
            .iter()
            .any(|key| key.len() != 64 || !key.bytes().all(|byte| byte.is_ascii_hexdigit()))
    {
        return Err("Saved global key binding approvals are invalid".into());
    }
    {
        let state = app.state::<KeybindingsState>();
        let mut inner = state.inner.lock().unwrap();
        inner.bindings = configuration.bindings;
        inner.global_approvals = configuration.global_approvals;
    }
    apply(app)
}

fn fire(app: &AppHandle, binding: Binding) {
    if native_action(&binding.action) {
        let _ = app.emit_to("main", "desktop-keybinding-action", &binding.action);
    } else if let Some(window) = app.get_webview_window("frontend") {
        if frontend_origin(&window).ok().as_deref() == binding.origin.as_deref() {
            let _ = app.emit_to(
                "frontend",
                "desktop-keybinding-trigger",
                Trigger {
                    binding_id: binding.id,
                    command_id: binding.action,
                    scope: binding.scope,
                    account_id: binding.account_id.unwrap_or_default(),
                },
            );
        }
    }
}

pub fn global_event(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event == ShortcutState::Released {
        app.state::<KeybindingsState>()
            .inner
            .lock()
            .unwrap()
            .pressed
            .remove(&shortcut.id());
        return;
    }
    if app
        .get_webview_window("keybindings")
        .is_some_and(|window| window.is_focused().unwrap_or(false))
    {
        return;
    }
    let frontend_focused = app
        .get_webview_window("frontend")
        .is_some_and(|window| window.is_focused().unwrap_or(false));
    let binding = {
        let state = app.state::<KeybindingsState>();
        let mut inner = state.inner.lock().unwrap();
        if inner.editing && frontend_focused {
            return;
        }
        if !inner.pressed.insert(shortcut.id()) {
            return;
        }
        inner
            .bindings
            .iter()
            .find(|b| {
                b.scope == Scope::Global
                    && eligible(b, &inner.catalog)
                    && !inner.errors.contains_key(&b.id)
                    && b.chord.shortcut().is_ok_and(|s| s == *shortcut)
            })
            .cloned()
    };
    if let Some(binding) = binding {
        fire(app, binding);
    }
}

pub fn frontend_focus_changed(app: &AppHandle) {
    if !app
        .state::<KeybindingsState>()
        .inner
        .lock()
        .unwrap()
        .editing
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KeybindingsState>();
        let _changes = state.changes.lock().unwrap();
        let _ = apply(&app);
    });
}

pub fn frontend_gone(app: &AppHandle) {
    // Drop command authority immediately; native desktop actions remain usable.
    {
        let state = app.state::<KeybindingsState>();
        let mut inner = state.inner.lock().unwrap();
        inner.catalog = Catalog::default();
        inner.editing = false;
    }
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<KeybindingsState>();
        let _changes = state.changes.lock().unwrap();
        let _ = apply(&app);
    });
}

fn global_available(app: &AppHandle) -> bool {
    #[cfg(target_os = "linux")]
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .is_ok_and(|value| value.eq_ignore_ascii_case("wayland"))
    {
        // XWayland grabs do not provide global shortcuts in native Wayland apps.
        return false;
    }
    app.try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>()
        .is_some()
}

#[tauri::command]
pub fn desktop_keybindings_show(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    crate::capture::trusted_host(&window)?;
    if let Some(window) = app.get_webview_window("keybindings") {
        return window.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "keybindings",
        tauri::WebviewUrl::App("keybindings.html".into()),
    )
    .title("Desktop Key Bindings")
    .inner_size(800.0, 620.0)
    .min_inner_size(520.0, 400.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_keybindings_get(app: AppHandle, window: WebviewWindow) -> Result<Snapshot, String> {
    local_page(&window, "keybindings", "/keybindings.html")?;
    let state = app.state::<KeybindingsState>();
    let inner = state.inner.lock().unwrap();
    Ok(Snapshot {
        bindings: inner.bindings.clone(),
        commands: inner.catalog.commands.clone(),
        origin: inner.catalog.origin.clone(),
        account_id: inner.catalog.account.clone(),
        errors: inner.errors.clone(),
        global_available: global_available(&app),
        global_enabled: inner
            .global_approvals
            .contains(&approval_key(&inner.catalog)),
    })
}

#[tauri::command]
pub async fn desktop_keybindings_save(
    app: AppHandle,
    window: WebviewWindow,
    bindings: Vec<Binding>,
) -> Result<(), String> {
    local_page(&window, "keybindings", "/keybindings.html")?;
    validate(&bindings)?;
    let state = app.state::<KeybindingsState>();
    let _changes = state.changes.lock().unwrap();
    let approvals = state.inner.lock().unwrap().global_approvals.clone();
    commit(&app, bindings, approvals)
}

// Caller holds changes. Persist bindings and native global opt-in atomically.
fn commit(
    app: &AppHandle,
    bindings: Vec<Binding>,
    global_approvals: BTreeSet<String>,
) -> Result<(), String> {
    let state = app.state::<KeybindingsState>();
    let previous = {
        let mut inner = state.inner.lock().unwrap();
        Configuration {
            bindings: std::mem::replace(&mut inner.bindings, bindings),
            global_approvals: std::mem::replace(&mut inner.global_approvals, global_approvals),
        }
    };
    let save = (|| -> Result<(), String> {
        apply(&app)?;
        let inner = state.inner.lock().unwrap();
        if let Some(error) = inner.errors.values().next() {
            return Err(error.clone());
        }
        let path = path(&app)?;
        fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let temporary = path.with_extension("tmp");
        fs::write(
            &temporary,
            serde_json::to_vec(&Configuration {
                bindings: inner.bindings.clone(),
                global_approvals: inner.global_approvals.clone(),
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, path).map_err(|e| e.to_string())
    })();
    if let Err(error) = save {
        {
            let mut inner = state.inner.lock().unwrap();
            inner.bindings = previous.bindings;
            inner.global_approvals = previous.global_approvals;
        }
        let _ = apply(&app);
        return Err(error);
    }
    let _ = app.emit_to("frontend", "desktop-keybindings-changed", ());
    let _ = app.emit_to("keybindings", "desktop-keybindings-catalog", ());
    Ok(())
}

#[tauri::command]
pub fn desktop_keybindings_frontend_get(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Snapshot, String> {
    let origin = frontend_origin(&window)?;
    let state = app.state::<KeybindingsState>();
    let inner = state.inner.lock().unwrap();
    let catalog = frontend_catalog(&inner, &origin)?;
    let bindings: Vec<Binding> = inner
        .bindings
        .iter()
        .filter(|binding| visible(binding, &catalog))
        .cloned()
        .collect();
    Ok(Snapshot {
        errors: inner
            .errors
            .iter()
            .filter(|(id, _)| bindings.iter().any(|binding| &binding.id == *id))
            .map(|(id, error)| (id.clone(), error.clone()))
            .collect(),
        global_available: global_available(&app),
        global_enabled: inner.global_approvals.contains(&approval_key(&catalog)),
        bindings,
        commands: catalog.commands,
        origin: catalog.origin,
        account_id: catalog.account,
    })
}

#[tauri::command]
pub async fn desktop_keybindings_frontend_save(
    app: AppHandle,
    window: WebviewWindow,
    account_id: String,
    bindings: Vec<Binding>,
    command_id: Option<String>,
) -> Result<(), String> {
    let origin = frontend_origin(&window)?;
    let state = app.state::<KeybindingsState>();
    let _changes = state.changes.lock().unwrap();
    let (merged, approvals) = {
        let inner = state.inner.lock().unwrap();
        let catalog = frontend_catalog(&inner, &origin)?;
        if catalog.account != account_id {
            return Err("The active account changed".into());
        }
        (
            merge_frontend_bindings(&inner, &catalog, bindings, command_id.as_deref())?,
            inner.global_approvals.clone(),
        )
    };
    commit(&app, merged, approvals)
}

#[tauri::command]
pub async fn desktop_keybindings_editing(
    app: AppHandle,
    window: WebviewWindow,
    editing: bool,
) -> Result<(), String> {
    frontend_origin(&window)?;
    let state = app.state::<KeybindingsState>();
    let _changes = state.changes.lock().unwrap();
    state.inner.lock().unwrap().editing = editing;
    apply(&app)
}

#[tauri::command]
pub async fn desktop_keybindings_global_permission(
    app: AppHandle,
    window: WebviewWindow,
    account_id: String,
    enabled: bool,
) -> Result<bool, String> {
    let origin = frontend_origin(&window)?;
    let state = app.state::<KeybindingsState>();
    let catalog = {
        let mut inner = state.inner.lock().unwrap();
        let catalog = frontend_catalog(&inner, &origin)?;
        if catalog.account != account_id {
            return Err("The active account changed".into());
        }
        if enabled {
            if !global_available(&app) {
                return Err("Global shortcuts are unavailable in this desktop session".into());
            }
            if inner.global_approvals.contains(&approval_key(&catalog)) {
                return Ok(true);
            }
            if inner.approval_pending {
                return Err("A global key binding approval is already open".into());
            }
            if inner.global_approvals.len() >= 64 {
                return Err("Too many global key binding approvals".into());
            }
            inner.approval_pending = true;
        }
        catalog
    };
    if enabled {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog().message("Allow Lumiverse and extension shortcuts to run while you use other apps?\n\nYou can change or disable them in Settings → Key Bindings.")
            .title("Enable Global Key Bindings?")
            .parent(&window)
            .buttons(MessageDialogButtons::OkCancelCustom("Enable Global Bindings".into(), "Cancel".into()))
            .show(move |answer| { let _ = tx.send(answer); });
        let answer = rx.await.unwrap_or(false);
        state.inner.lock().unwrap().approval_pending = false;
        if !answer {
            return Ok(false);
        }
    }
    let _changes = state.changes.lock().unwrap();
    // The page/account may change while the native opt-in dialog is open.
    if frontend_origin(&window)? != origin {
        return Err("The active instance changed".into());
    }
    let (mut bindings, mut approvals) = {
        let inner = state.inner.lock().unwrap();
        let current = frontend_catalog(&inner, &origin)?;
        if current.account != catalog.account {
            return Err("The active account changed".into());
        }
        (inner.bindings.clone(), inner.global_approvals.clone())
    };
    if enabled {
        approvals.insert(approval_key(&catalog));
    } else {
        approvals.remove(&approval_key(&catalog));
        for binding in bindings
            .iter_mut()
            .filter(|binding| visible(binding, &catalog))
        {
            binding.scope = Scope::Focused;
        }
    }
    commit(&app, bindings, approvals)?;
    Ok(enabled)
}

#[tauri::command]
pub async fn desktop_keybindings_publish(
    app: AppHandle,
    window: WebviewWindow,
    account_id: String,
    commands: Vec<Command>,
) -> Result<Vec<Binding>, String> {
    let origin = frontend_origin(&window)?;
    if commands.len() > 1024
        || (!account_id.is_empty() && !valid_text(&account_id, 128))
        || commands
            .iter()
            .any(|c| !valid_text(&c.id, 256) || !valid_text(&c.label, 160))
    {
        return Err("Invalid command catalog".into());
    }
    let state = app.state::<KeybindingsState>();
    let _changes = state.changes.lock().unwrap();
    let catalog = Catalog {
        origin,
        account: account_id,
        commands,
    };
    let changed = {
        let mut inner = state.inner.lock().unwrap();
        if inner.catalog == catalog {
            false
        } else {
            inner.catalog = catalog;
            true
        }
    };
    if changed {
        apply(&app)?;
        let _ = app.emit_to("keybindings", "desktop-keybindings-catalog", ());
        let _ = app.emit_to("frontend", "desktop-keybindings-catalog", ());
    }
    let inner = state.inner.lock().unwrap();
    Ok(inner
        .bindings
        .iter()
        .filter(|b| eligible(b, &inner.catalog) && !inner.errors.contains_key(&b.id))
        .cloned()
        .collect())
}

#[tauri::command]
pub fn desktop_keybindings_trigger(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    let origin = frontend_origin(&window)?;
    if !window.is_focused().map_err(|e| e.to_string())? {
        return Err("The Lumiverse window is not focused".into());
    }
    let binding = {
        let state = app.state::<KeybindingsState>();
        let inner = state.inner.lock().unwrap();
        if inner.catalog.origin != origin {
            return Err("The command catalog changed".into());
        }
        inner
            .bindings
            .iter()
            .find(|b| b.id == id && b.scope == Scope::Focused && eligible(b, &inner.catalog))
            .cloned()
    }
    .ok_or("Binding is unavailable")?;
    fire(&app, binding);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> Binding {
        Binding {
            id: uuid::Uuid::new_v4().to_string(),
            chord: Chord {
                code: "KeyP".into(),
                ctrl: true,
                alt: false,
                shift: true,
                meta: false,
            },
            scope: Scope::Focused,
            action: "ext-cmd-installed-analyze".into(),
            origin: Some("https://instance".into()),
            account_id: Some("alice".into()),
        }
    }
    #[test]
    fn commands_require_the_same_instance_account_and_live_registration() {
        let binding = binding();
        let mut catalog = Catalog {
            origin: "https://instance".into(),
            account: "alice".into(),
            commands: vec![Command {
                id: binding.action.clone(),
                label: "Analyze".into(),
            }],
        };
        assert!(eligible(&binding, &catalog));
        catalog.account = "bob".into();
        assert!(!eligible(&binding, &catalog));
        catalog.account = "alice".into();
        catalog.origin = "https://other".into();
        assert!(!eligible(&binding, &catalog));
        catalog.origin = "https://instance".into();
        catalog.commands.clear();
        assert!(!eligible(&binding, &catalog));
    }
    #[test]
    fn plain_text_and_duplicate_chords_are_rejected() {
        let mut binding = binding();
        assert!(validate(&[binding.clone()]).is_ok());
        let mut second = binding.clone();
        second.id = uuid::Uuid::new_v4().to_string();
        second.scope = Scope::Global;
        assert!(validate(&[binding.clone(), second]).is_err());
        binding.chord.ctrl = false;
        assert!(validate(&[binding.clone()]).is_err());
        binding.chord.ctrl = true;
        binding.chord.code = "ShiftLeft".into();
        assert!(validate(&[binding]).is_err());
    }

    #[test]
    fn extended_function_keys_support_standalone_and_modified_global_bindings() {
        let mut bindings = Vec::new();
        let mut shortcut_ids = BTreeSet::new();
        for number in 13..=24 {
            for (ctrl, alt, shift, meta) in [
                (false, false, false, false),
                (false, false, true, false),
                (true, false, false, false),
                (false, true, false, false),
                (false, false, false, true),
            ] {
                let mut binding = binding();
                binding.scope = Scope::Global;
                binding.chord = Chord {
                    code: format!("F{number}"),
                    ctrl,
                    alt,
                    shift,
                    meta,
                };
                assert!(shortcut_ids.insert(binding.chord.shortcut().unwrap().id()));
                bindings.push(binding);
            }
        }
        assert!(validate(&bindings).is_ok());
        let mut duplicate = bindings[0].clone();
        duplicate.id = uuid::Uuid::new_v4().to_string();
        duplicate.scope = Scope::Focused;
        assert!(validate(&[bindings[0].clone(), duplicate]).is_err());
    }

    #[test]
    fn other_keys_still_require_control_alt_or_super() {
        for code in ["F1", "F12", "KeyP", "Digit1", "Space", "Enter", "ArrowUp"] {
            for shift in [false, true] {
                let chord = Chord {
                    code: code.into(),
                    ctrl: false,
                    alt: false,
                    shift,
                    meta: false,
                };
                assert!(chord.shortcut().is_err(), "{code} must require a modifier");
            }
        }
        for code in ["F0", "F25", "F013", "ShiftLeft"] {
            let chord = Chord {
                code: code.into(),
                ctrl: true,
                alt: false,
                shift: false,
                meta: false,
            };
            assert!(chord.shortcut().is_err(), "{code} is unsupported");
        }
    }

    #[test]
    fn native_and_account_bindings_cannot_compete_but_other_accounts_can_reuse_keys() {
        let first = binding();
        let mut other = first.clone();
        other.id = uuid::Uuid::new_v4().to_string();
        other.account_id = Some("bob".into());
        assert!(validate(&[first.clone(), other.clone()]).is_ok());
        other.action = "desktop:show-window".into();
        other.account_id = None;
        other.origin = None;
        assert!(validate(&[first, other]).is_err());
    }

    fn catalog(binding: &Binding) -> Catalog {
        Catalog {
            origin: binding.origin.clone().unwrap(),
            account: binding.account_id.clone().unwrap(),
            commands: vec![Command {
                id: binding.action.clone(),
                label: "Analyze".into(),
            }],
        }
    }

    #[test]
    fn recording_releases_global_keys_only_while_the_frontend_is_focused() {
        let mut binding = binding();
        binding.scope = Scope::Global;
        let mut inner = Inner {
            catalog: catalog(&binding),
            bindings: vec![binding.clone()],
            ..Default::default()
        };
        assert!(global_active(&binding, &inner, true));
        inner.editing = true;
        assert!(!global_active(&binding, &inner, true));
        assert!(global_active(&binding, &inner, false));
        inner.editing = false;
        assert!(global_active(&binding, &inner, true));
        inner.catalog.commands.clear();
        assert!(!global_active(&binding, &inner, false));
        assert!(visible(&binding, &inner.catalog));
        inner.catalog = catalog(&binding);
        assert!(global_active(&binding, &inner, false));
        assert_eq!(inner.bindings, vec![binding]);
    }

    #[test]
    fn frontend_edits_preserve_other_accounts_and_need_native_opt_in_for_global_changes() {
        let mut first = binding();
        let catalog = catalog(&first);
        let mut other = first.clone();
        other.id = uuid::Uuid::new_v4().to_string();
        other.account_id = Some("bob".into());
        let mut inner = Inner {
            bindings: vec![first.clone(), other.clone()],
            ..Default::default()
        };
        first.chord.code = "KeyO".into();
        let merged = merge_frontend_bindings(&inner, &catalog, vec![first.clone()], None).unwrap();
        assert_eq!(merged, vec![other.clone(), first.clone()]);
        assert!(merge_frontend_bindings(&inner, &catalog, vec![other], None).is_err());
        first.scope = Scope::Global;
        assert!(merge_frontend_bindings(&inner, &catalog, vec![first.clone()], None).is_err());
        let mut another_account = catalog.clone();
        another_account.account = "bob".into();
        inner
            .global_approvals
            .insert(approval_key(&another_account));
        assert!(merge_frontend_bindings(&inner, &catalog, vec![first.clone()], None).is_err());
        inner.global_approvals.insert(approval_key(&catalog));
        assert!(merge_frontend_bindings(&inner, &catalog, vec![first], None).is_ok());
    }

    #[test]
    fn existing_native_global_bindings_can_be_preserved_or_removed_without_new_global_authority() {
        let mut first = binding();
        first.scope = Scope::Global;
        let catalog = catalog(&first);
        let inner = Inner {
            bindings: vec![first.clone()],
            ..Default::default()
        };
        assert!(merge_frontend_bindings(&inner, &catalog, vec![first.clone()], None).is_ok());
        first.chord.code = "KeyO".into();
        assert!(merge_frontend_bindings(&inner, &catalog, vec![first.clone()], None).is_err());
        first.scope = Scope::Focused;
        assert!(merge_frontend_bindings(&inner, &catalog, vec![first], None).is_ok());
        assert!(merge_frontend_bindings(&inner, &catalog, vec![], None)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn inline_command_edits_cannot_replace_unrelated_bindings() {
        let first = binding();
        let catalog = catalog(&first);
        let mut other = first.clone();
        other.id = uuid::Uuid::new_v4().to_string();
        other.action = "other-command".into();
        other.chord.code = "KeyO".into();
        let inner = Inner {
            bindings: vec![first.clone(), other.clone()],
            ..Default::default()
        };
        assert_eq!(
            merge_frontend_bindings(&inner, &catalog, vec![], Some(&first.action)).unwrap(),
            vec![other.clone()]
        );
        assert!(
            merge_frontend_bindings(&inner, &catalog, vec![other], Some(&first.action)).is_err()
        );
        assert!(
            merge_frontend_bindings(&inner, &catalog, vec![], Some("unregistered-command"))
                .is_err()
        );
        assert!(frontend_catalog(&inner, "https://other").is_err());
        assert!(frontend_catalog(&inner, &catalog.origin).is_err()); // no live signed-in catalog
    }
}
