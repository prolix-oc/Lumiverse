//! Discord Rich Presence for the desktop tray.
//!
//! A dedicated thread owns the blocking IPC connection to the local Discord
//! client (a named pipe on Windows, a Unix domain socket elsewhere) so a
//! wedged Discord can never stall the Tauri runtime. Only the public
//! application ID is involved: Discord grants `rpc.local` to any local IPC
//! connection, so there is no client secret and no OAuth flow here.

use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

/// Public Discord application ID for Lumiverse (Developer Portal →
/// General Information → Application ID). Rich Presence over the local IPC
/// pipe requires only this public ID — there is no client secret to protect.
/// Discord renders "Playing <application name>", so the portal entry is named
/// "Lumiverse"; the presence art references the portal's `lumiverse-icon`
/// Rich Presence asset.
const DISCORD_APPLICATION_ID: &str = "1557028882736222328";
const LARGE_IMAGE_KEY: &str = "lumiverse-icon";

/// Discord rate-limits RPC connections per client; back off between attempts
/// when the desktop client is not running.
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_secs(30);
/// Discord caps presence text fields at 128 bytes.
const MAX_FIELD_BYTES: usize = 128;

/// Snapshot payload relayed from the tray (which fetches it from the
/// instance's desktop API) into the worker thread. `chat_id` is only used to
/// detect chat switches; it is never sent to Discord.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresencePayload {
    #[serde(default)]
    pub chat_id: Option<String>,
    #[serde(default)]
    pub character_name: Option<String>,
    #[serde(default)]
    pub message_count: Option<u64>,
    #[serde(default)]
    pub total_tokens: Option<u64>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub character_count: Option<u64>,
}

enum PresenceCommand {
    SetEnabled(bool),
    Update(Option<PresencePayload>),
    Shutdown,
}

#[derive(Default)]
pub struct DiscordRpcState {
    sender: Mutex<Option<Sender<PresenceCommand>>>,
}

impl DiscordRpcState {
    /// Lazily start the worker thread and deliver a command. The worker is
    /// detached: a blocking IPC call inside it can never wedge the app, and
    /// process exit closes the pipe (which drops the presence on Discord's
    /// side even if the explicit clear did not get through).
    fn send(&self, command: PresenceCommand) -> Result<(), String> {
        let mut sender = self.sender.lock().map_err(|_| "Discord RPC worker poisoned")?;
        if sender.is_none() {
            let (tx, receiver) = mpsc::channel::<PresenceCommand>();
            thread::Builder::new()
                .name("discord-rpc".into())
                .spawn(move || run_worker(receiver))
                .map_err(|error| error.to_string())?;
            *sender = Some(tx);
        }
        sender
            .as_ref()
            .expect("worker spawned above")
            .send(command)
            .map_err(|_| "Discord RPC worker stopped".to_string())
    }
}

#[tauri::command]
pub fn discord_rpc_set_enabled(state: State<'_, DiscordRpcState>, enabled: bool) -> Result<(), String> {
    state.send(PresenceCommand::SetEnabled(enabled))
}

#[tauri::command]
pub fn discord_rpc_update(state: State<'_, DiscordRpcState>, payload: Option<PresencePayload>) -> Result<(), String> {
    state.send(PresenceCommand::Update(payload))
}

/// The frontend can request a fresh snapshot after a committed chat switch.
/// Only the tray can fetch that snapshot or send activity to Discord.
#[tauri::command]
pub fn discord_presence_changed(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    if window.label() != "frontend" {
        return Err("Only the primary frontend can refresh Discord presence".into());
    }
    let url = window.url().map_err(|error| error.to_string())?;
    app.emit_to(
        "main",
        "discord-presence-changed",
        serde_json::json!({ "origin": url.origin().ascii_serialization() }),
    )
    .map_err(|error| error.to_string())
}

/// Best-effort clear from the app exit path. This never joins the worker, so
/// exit cannot hang on a stuck IPC write.
pub fn shutdown(state: &DiscordRpcState) {
    let _ = state.send(PresenceCommand::Shutdown);
}

struct WorkerState {
    enabled: bool,
    payload: Option<PresencePayload>,
    client: Option<DiscordIpcClient>,
    last_connect_attempt: Option<Instant>,
    /// Elapsed-time anchor for the current chat session (Unix milliseconds).
    session_started_ms: Option<i64>,
    session_chat_id: Option<String>,
    /// Rendered presence last accepted by Discord, to skip no-op updates.
    last_sent: Option<String>,
}

impl Default for WorkerState {
    fn default() -> Self {
        Self {
            enabled: false,
            payload: None,
            client: None,
            last_connect_attempt: None,
            session_started_ms: None,
            session_chat_id: None,
            last_sent: None,
        }
    }
}

fn run_worker(receiver: Receiver<PresenceCommand>) {
    let mut state = WorkerState::default();
    for command in receiver {
        match command {
            PresenceCommand::SetEnabled(enabled) => {
                state.enabled = enabled;
                if enabled {
                    // Restart the elapsed timer on re-enable.
                    state.session_started_ms = None;
                    state.apply();
                } else {
                    state.clear_activity();
                }
            }
            PresenceCommand::Update(payload) => {
                state.payload = payload;
                state.apply();
            }
            PresenceCommand::Shutdown => {
                state.clear_activity();
                if let Some(mut client) = state.client.take() {
                    let _ = client.close();
                }
                return;
            }
        }
    }
}

impl WorkerState {
    fn apply(&mut self) {
        if !self.enabled {
            return;
        }
        let Some(payload) = self.payload.clone() else {
            self.clear_activity();
            return;
        };

        self.track_session(payload.chat_id.as_deref());

        let (details, state_text, large_text) = render_presence(&payload);
        let rendered = format!("{details}\u{1f}{state_text}\u{1f}{}", large_text.as_deref().unwrap_or(""));
        if self.client.is_some() && self.last_sent.as_deref() == Some(rendered.as_str()) {
            return;
        }

        let mut act = activity::Activity::new()
            .details(&details)
            .state(&state_text);
        if let Some(text) = &large_text {
            act = act.assets(
                activity::Assets::new()
                    .large_image(LARGE_IMAGE_KEY)
                    .large_text(text.as_str()),
            );
        }
        if let Some(start) = self.session_started_ms {
            act = act.timestamps(activity::Timestamps::new().start(start));
        }

        // Compute the result while the client borrow is alive, then drop the
        // borrow before touching any other worker state.
        let result = match self.ensure_connected() {
            Some(client) => client
                .set_activity(act)
                .map_err(|error| error.to_string()),
            None => return,
        };
        match result {
            Ok(()) => self.last_sent = Some(rendered),
            Err(error) => {
                eprintln!("[discord-rpc] set_activity failed: {error}");
                self.client = None;
                self.last_connect_attempt = None;
            }
        }
    }

    fn track_session(&mut self, chat_id: Option<&str>) {
        if self.session_chat_id.as_deref() != chat_id || self.session_started_ms.is_none() {
            self.session_chat_id = chat_id.map(str::to_owned);
            self.session_started_ms = Some(now_unix_ms());
            // A new chat needs a new RPC timestamp even when its rendered
            // character, model, and metrics match the previous chat.
            self.last_sent = None;
        }
    }

    fn clear_activity(&mut self) {
        self.last_sent = None;
        if let Some(client) = self.client.as_mut() {
            if let Err(error) = client.clear_activity() {
                eprintln!("[discord-rpc] clear_activity failed: {error}");
            }
        }
    }

    fn ensure_connected(&mut self) -> Option<&mut DiscordIpcClient> {
        if self.client.is_some() {
            return self.client.as_mut();
        }
        if let Some(attempt) = self.last_connect_attempt {
            if attempt.elapsed() < CONNECT_RETRY_INTERVAL {
                return None;
            }
        }
        self.last_connect_attempt = Some(Instant::now());
        let mut client = DiscordIpcClient::new(DISCORD_APPLICATION_ID);
        match client.connect() {
            Ok(()) => {
                eprintln!("[discord-rpc] connected to Discord");
                self.client = Some(client);
                self.client.as_mut()
            }
            Err(error) => {
                eprintln!("[discord-rpc] connect failed (is the Discord desktop app running?): {error}");
                None
            }
        }
    }
}

/// Render the payload into the (details, state, large-image hover) fields.
fn render_presence(payload: &PresencePayload) -> (String, String, Option<String>) {
    if payload.chat_id.is_none() {
        if let Some(count) = payload.character_count {
            let noun = if count == 1 { "character" } else { "characters" };
            return (
                "Choosing a chat".into(),
                format!("{count} {noun}"),
                Some("Lumiverse".into()),
            );
        }
    }

    let details = match payload.character_name.as_deref().map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => clamp_field(&format!("Roleplaying with {name}")),
        None => "Roleplaying in Lumiverse".to_string(),
    };

    let mut parts: Vec<String> = Vec::new();
    if let Some(count) = payload.message_count {
        parts.push(format!("{count} messages"));
    }
    if let Some(tokens) = payload.total_tokens {
        parts.push(format!("{} tokens", format_tokens(tokens)));
    }
    if parts.is_empty() {
        parts.push("In a roleplay session".to_string());
    }
    let large_text = payload
        .model
        .as_deref()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(clamp_field);

    if let Some(model) = &large_text {
        parts.push(model.clone());
    }
    let state_text = clamp_field(&parts.join(" · "));

    (details, state_text, large_text)
}

fn format_tokens(total: u64) -> String {
    if total < 1000 {
        return total.to_string();
    }
    let thousands = total as f64 / 1000.0;
    if thousands >= 100.0 {
        format!("{thousands:.0}k")
    } else {
        format!("{thousands:.1}k").replace(".0k", "k")
    }
}

fn clamp_field(value: &str) -> String {
    if value.len() <= MAX_FIELD_BYTES {
        return value.to_string();
    }
    let mut end = MAX_FIELD_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].trim_end().to_string()
}

fn now_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(character: Option<&str>, count: Option<u64>, tokens: Option<u64>, model: Option<&str>) -> PresencePayload {
        PresencePayload {
            chat_id: Some("chat-1".into()),
            character_name: character.map(|value| value.into()),
            message_count: count,
            total_tokens: tokens,
            model: model.map(|value| value.into()),
            character_count: None,
        }
    }

    #[test]
    fn details_uses_the_configured_character_wording() {
        let (details, _, _) = render_presence(&payload(Some("Aria"), Some(2), Some(3), Some("m1")));
        assert_eq!(details, "Roleplaying with Aria");
    }

    #[test]
    fn switching_chats_invalidates_an_identical_rendered_activity() {
        let mut worker = WorkerState::default();
        worker.session_chat_id = Some("chat-1".into());
        worker.session_started_ms = Some(1);
        worker.last_sent = Some("identical character and metrics".into());

        worker.track_session(Some("chat-2"));
        assert_eq!(worker.session_chat_id.as_deref(), Some("chat-2"));
        assert!(worker.session_started_ms.unwrap() > 1);
        assert!(worker.last_sent.is_none());
    }

    #[test]
    fn polling_the_same_chat_keeps_its_session_and_deduplication() {
        let mut worker = WorkerState::default();
        worker.session_chat_id = Some("chat-1".into());
        worker.session_started_ms = Some(1);
        worker.last_sent = Some("same activity".into());

        worker.track_session(Some("chat-1"));
        assert_eq!(worker.session_started_ms, Some(1));
        assert_eq!(worker.last_sent.as_deref(), Some("same activity"));
    }

    #[test]
    fn landing_snapshot_survives_the_native_relay_and_renders_both_lines() {
        for (count, expected) in [(0, "0 characters"), (1, "1 character"), (24, "24 characters")] {
            let snapshot: crate::remote_instance::PresenceSnapshotDto = serde_json::from_value(
                serde_json::json!({
                    "chatId": null,
                    "characterName": null,
                    "messageCount": null,
                    "totalTokens": null,
                    "model": null,
                    "characterCount": count,
                }),
            ).unwrap();
            let payload: PresencePayload = serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap();
            let (details, state, hover) = render_presence(&payload);
            assert_eq!(details, "Choosing a chat");
            assert_eq!(state, expected);
            assert_eq!(hover.as_deref(), Some("Lumiverse"));
        }
    }

    #[test]
    fn landing_transitions_restart_the_timer_and_keep_identical_polls_deduplicated() {
        let mut worker = WorkerState::default();
        worker.session_chat_id = Some("chat-1".into());
        worker.session_started_ms = Some(1);
        worker.last_sent = Some("chat activity".into());
        worker.track_session(None);
        assert!(worker.session_chat_id.is_none());
        assert!(worker.last_sent.is_none());
        let landing_start = worker.session_started_ms;
        worker.last_sent = Some("landing activity".into());
        worker.track_session(None);
        assert_eq!(worker.session_started_ms, landing_start);
        assert_eq!(worker.last_sent.as_deref(), Some("landing activity"));
        worker.track_session(Some("chat-1"));
        assert_eq!(worker.session_chat_id.as_deref(), Some("chat-1"));
        assert!(worker.last_sent.is_none());
    }

    #[test]
    fn details_falls_back_without_a_character() {
        for name in [None, Some(""), Some("   ")] {
            let (details, _, _) = render_presence(&payload(name, Some(2), Some(3), None));
            assert_eq!(details, "Roleplaying in Lumiverse");
        }
    }

    #[test]
    fn state_joins_counts_and_tokens() {
        let (_, state, _) = render_presence(&payload(Some("Aria"), Some(142), Some(56_780), None));
        assert_eq!(state, "142 messages · 56.8k tokens");
    }

    #[test]
    fn state_has_a_fallback_without_metrics() {
        let (_, state, _) = render_presence(&payload(Some("Aria"), None, None, None));
        assert_eq!(state, "In a roleplay session");
    }

    #[test]
    fn model_is_visible_in_activity_and_image_hover() {
        let (_, state, large) = render_presence(&payload(Some("Aria"), Some(73), Some(98_300), Some("claude-sonnet-4-5")));
        assert_eq!(state, "73 messages · 98.3k tokens · claude-sonnet-4-5");
        assert_eq!(large.as_deref(), Some("claude-sonnet-4-5"));
        let (_, state, large) = render_presence(&payload(Some("Aria"), Some(73), Some(98_300), Some("  ")));
        assert_eq!(state, "73 messages · 98.3k tokens");
        assert_eq!(large, None);
    }

    #[test]
    fn token_counts_format_compactly() {
        assert_eq!(format_tokens(999), "999");
        assert_eq!(format_tokens(1_000), "1k");
        assert_eq!(format_tokens(1_234), "1.2k");
        assert_eq!(format_tokens(56_780), "56.8k");
        assert_eq!(format_tokens(4_210_000), "4210k");
    }

    #[test]
    fn fields_are_clamped_on_char_boundaries() {
        let long = "字符".repeat(200);
        let clamped = clamp_field(&long);
        assert!(clamped.len() <= MAX_FIELD_BYTES);
        assert!(long.starts_with(&clamped));
        assert!(clamped.is_char_boundary(clamped.len()));
    }
}
