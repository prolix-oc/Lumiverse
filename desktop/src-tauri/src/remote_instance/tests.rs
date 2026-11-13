use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use super::*;

#[test]
fn profiles_keep_existing_credentials_and_isolate_test_credentials() {
    let production = KeyringCredentialStore::for_identifier("chat.lumiverse.tray");
    let debug = KeyringCredentialStore::for_identifier("chat.lumiverse.tray.debug");
    let named =
        KeyringCredentialStore::for_identifier("chat.lumiverse.tray.debug.profile.setup-test-1");
    assert_eq!(production.service, KEYRING_SERVICE);
    assert_ne!(debug.service, production.service);
    assert_ne!(named.service, debug.service);
    assert_ne!(named.service, production.service);
}

#[derive(Default)]
struct TestCredentials {
    token: Mutex<Option<String>>,
    unavailable: AtomicBool,
    deletions: AtomicUsize,
}

impl RefreshCredentialStore for TestCredentials {
    fn save(&self, _origin: &str, token: &str) -> Result<(), String> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err("Credential store locked".into());
        }
        *self.token.lock().unwrap() = Some(token.into());
        Ok(())
    }

    fn load(&self, _origin: &str) -> Result<Option<String>, String> {
        if self.unavailable.load(Ordering::SeqCst) {
            return Err("Credential store locked".into());
        }
        Ok(self.token.lock().unwrap().clone())
    }

    fn delete(&self, _origin: &str) -> Result<(), String> {
        self.deletions.fetch_add(1, Ordering::SeqCst);
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

#[derive(Default)]
struct TestBackendState {
    refreshes: AtomicUsize,
    generation: AtomicUsize,
    refresh_error: Mutex<Option<(u16, String)>>,
}

struct TestBackend {
    origin: String,
    state: Arc<TestBackendState>,
    task: tokio::task::JoinHandle<()>,
}

impl TestBackend {
    async fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let state = Arc::new(TestBackendState::default());
        let server_origin = origin.clone();
        let server_state = state.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let origin = server_origin.clone();
                let state = server_state.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0; 4096];
                    let (headers, body) = loop {
                        let read = stream.read(&mut buffer).await.unwrap();
                        assert!(read > 0);
                        request.extend_from_slice(&buffer[..read]);
                        let text = String::from_utf8_lossy(&request);
                        if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                            let length = headers
                                .lines()
                                .find_map(|line| {
                                    let (name, value) = line.split_once(':')?;
                                    name.eq_ignore_ascii_case("content-length")
                                        .then(|| value.trim().parse::<usize>().unwrap())
                                })
                                .unwrap_or(0);
                            if body.len() >= length {
                                break (headers.to_string(), body[..length].to_string());
                            }
                        }
                    };
                    let path = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let (status, body) = match path {
                        "/api/auth/.well-known/openid-configuration" => (200, serde_json::json!({
                            "issuer": format!("{origin}/api/auth"),
                            "authorization_endpoint": format!("{origin}/api/auth/oauth2/authorize"),
                            "token_endpoint": format!("{origin}/api/auth/oauth2/token"),
                        }).to_string()),
                        "/api/auth/oauth2/token" => {
                            state.refreshes.fetch_add(1, Ordering::SeqCst);
                            let error = state.refresh_error.lock().unwrap().clone();
                            if let Some(error) = error {
                                error
                            } else {
                                let form = Url::parse(&format!("{origin}/?{body}")).unwrap();
                                let token = form.query_pairs().find(|(key, _)| key == "refresh_token")
                                    .unwrap().1.into_owned();
                                let generation = state.generation.load(Ordering::SeqCst);
                                if token != format!("refresh-{generation}") {
                                    (400, serde_json::json!({"error": "invalid_grant"}).to_string())
                                } else {
                                    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                                    // Keep rotation in flight long enough for the other real
                                    // HTTP consumers to try restoring/refreshing concurrently.
                                    tokio::time::sleep(Duration::from_millis(50)).await;
                                    (200, serde_json::json!({
                                        "access_token": format!("access-{generation}"),
                                        "refresh_token": format!("refresh-{generation}"),
                                        "expires_in": 300,
                                    }).to_string())
                                }
                            }
                        }
                        _ => {
                            let expected = format!("Bearer access-{}", state.generation.load(Ordering::SeqCst));
                            let authorized = headers.lines().any(|line| {
                                line.split_once(':').is_some_and(|(name, value)| {
                                    name.eq_ignore_ascii_case("authorization") && value.trim() == expected
                                })
                            });
                            if !authorized {
                                (401, "{}".into())
                            } else {
                                let body = match path {
                                    "/api/desktop/v1/me" => serde_json::json!({
                                        "instance": {"id": "instance", "name": "Test"},
                                        "account": {"id": "owner", "name": "Owner", "role": "owner"},
                                        "capabilities": {"canReadStatus": true},
                                    }),
                                    "/api/desktop/v1/status" => serde_json::json!({"uptime": 42}),
                                    "/api/desktop/v1/presence" => serde_json::json!({"active": null}),
                                    _ => panic!("Unexpected test endpoint: {path}"),
                                };
                                (200, body.to_string())
                            }
                        }
                    };
                    let response = format!(
                        "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    stream.write_all(response.as_bytes()).await.unwrap();
                });
            }
        });
        Self {
            origin,
            state,
            task,
        }
    }

    fn client_state(&self) -> (RemoteInstanceState, Arc<TestCredentials>) {
        let credentials = Arc::new(TestCredentials::default());
        credentials.save(&self.origin, "refresh-0").unwrap();
        let state = RemoteInstanceState {
            credentials: credentials.clone(),
            ..RemoteInstanceState::default()
        };
        (state, credentials)
    }

    fn seed_session(&self, state: &RemoteInstanceState, expired: bool) {
        state.sessions.lock().unwrap().insert(
            self.origin.clone(),
            RemoteOAuthSession {
                access_token: "rejected-access".into(),
                refresh_token: Some("refresh-0".into()),
                access_expires_at: if expired {
                    Instant::now()
                } else {
                    Instant::now() + Duration::from_secs(300)
                },
                credential_persisted: true,
            },
        );
    }
}

impl Drop for TestBackend {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[test]
fn status_presence_and_capture_share_one_rotating_credential() {
    tauri::async_runtime::block_on(async {
        for session in ["saved", "expired", "rejected"] {
            let backend = TestBackend::start().await;
            let (state, credentials) = backend.client_state();
            if session != "saved" {
                backend.seed_session(&state, session == "expired");
            }
            let (status, presence, capture) = tokio::join!(
                poll_remote_instance(&state, backend.origin.clone()),
                poll_presence(&state, backend.origin.clone()),
                poll_remote_instance(&state, backend.origin.clone()),
            );
            assert!(
                matches!(status.state, RemoteConnectionPhase::Connected),
                "{session}"
            );
            assert!(
                matches!(presence.unwrap(), PresenceFetch::Inactive),
                "{session}"
            );
            assert!(
                matches!(capture.state, RemoteConnectionPhase::Connected),
                "{session}"
            );
            assert_eq!(
                backend.state.refreshes.load(Ordering::SeqCst),
                1,
                "{session}"
            );
            assert_eq!(
                credentials.load(&backend.origin).unwrap().as_deref(),
                Some("refresh-1")
            );
            assert_eq!(credentials.deletions.load(Ordering::SeqCst), 0);

            // Simulate restarting Desktop with only its persisted credential.
            let restarted = RemoteInstanceState {
                credentials: credentials.clone(),
                ..RemoteInstanceState::default()
            };
            let restored = poll_remote_instance(&restarted, backend.origin.clone()).await;
            assert!(matches!(restored.state, RemoteConnectionPhase::Connected));
            assert_eq!(
                credentials.load(&backend.origin).unwrap().as_deref(),
                Some("refresh-2")
            );
        }
    });
}

#[test]
fn temporary_refresh_failures_preserve_the_saved_credential() {
    tauri::async_runtime::block_on(async {
        for error in [
            (503, "{\"error\":\"temporarily_unavailable\"}"),
            (400, "{\"error\":\"invalid_request\"}"),
            (401, "Proxy authentication required"),
        ] {
            let backend = TestBackend::start().await;
            let (state, credentials) = backend.client_state();
            backend.seed_session(&state, true);
            *backend.state.refresh_error.lock().unwrap() = Some((error.0, error.1.into()));
            let snapshot = poll_remote_instance(&state, backend.origin.clone()).await;
            assert!(matches!(snapshot.state, RemoteConnectionPhase::Unreachable));
            assert_eq!(
                credentials.load(&backend.origin).unwrap().as_deref(),
                Some("refresh-0")
            );
            assert_eq!(credentials.deletions.load(Ordering::SeqCst), 0);
            *backend.state.refresh_error.lock().unwrap() = None;
            let recovered = poll_remote_instance(&state, backend.origin.clone()).await;
            assert!(matches!(recovered.state, RemoteConnectionPhase::Connected));
        }
    });
}

#[test]
fn invalid_grant_requires_sign_in_and_removes_the_credential() {
    tauri::async_runtime::block_on(async {
        let backend = TestBackend::start().await;
        let (state, credentials) = backend.client_state();
        backend.seed_session(&state, true);
        *backend.state.refresh_error.lock().unwrap() =
            Some((400, "{\"error\":\"invalid_grant\"}".into()));
        let snapshot = poll_remote_instance(&state, backend.origin.clone()).await;
        assert!(matches!(
            snapshot.state,
            RemoteConnectionPhase::ReauthRequired
        ));
        assert!(credentials.load(&backend.origin).unwrap().is_none());
        assert!(!state.sessions.lock().unwrap().contains_key(&backend.origin));
    });
}

#[test]
fn a_locked_credential_store_recovers_without_sign_in() {
    tauri::async_runtime::block_on(async {
        let backend = TestBackend::start().await;
        let (state, credentials) = backend.client_state();
        credentials.unavailable.store(true, Ordering::SeqCst);
        let snapshot = poll_remote_instance(&state, backend.origin.clone()).await;
        assert!(matches!(snapshot.state, RemoteConnectionPhase::Unreachable));
        assert_eq!(backend.state.refreshes.load(Ordering::SeqCst), 0);
        assert_eq!(credentials.deletions.load(Ordering::SeqCst), 0);
        credentials.unavailable.store(false, Ordering::SeqCst);
        let recovered = poll_remote_instance(&state, backend.origin.clone()).await;
        assert!(matches!(recovered.state, RemoteConnectionPhase::Connected));

        // A keyring write can also fail after the backend rotates the token.
        backend.seed_session(&state, true);
        state
            .sessions
            .lock()
            .unwrap()
            .get_mut(&backend.origin)
            .unwrap()
            .refresh_token = Some("refresh-1".into());
        credentials.unavailable.store(true, Ordering::SeqCst);
        let snapshot = poll_remote_instance(&state, backend.origin.clone()).await;
        assert!(matches!(snapshot.state, RemoteConnectionPhase::Connected));
        assert!(!snapshot.credential_persisted);
        credentials.unavailable.store(false, Ordering::SeqCst);
        let saved = poll_remote_instance(&state, backend.origin.clone()).await;
        assert!(saved.credential_persisted);
        assert_eq!(
            credentials.load(&backend.origin).unwrap().as_deref(),
            Some("refresh-2")
        );
        assert_eq!(backend.state.refreshes.load(Ordering::SeqCst), 2);
    });
}

#[test]
fn another_origin_can_poll_while_one_origin_is_busy() {
    tauri::async_runtime::block_on(async {
        let backend = TestBackend::start().await;
        let (state, _) = backend.client_state();
        let _busy = state.lock_origin("https://busy.example.test").await;
        let snapshot = timeout(
            // This exercises real loopback I/O under ARM64 QEMU in CI; keep
            // a finite but scheduler-tolerant deadline under emulation.
            Duration::from_secs(10),
            poll_remote_instance(&state, backend.origin.clone()),
        )
        .await
        .unwrap();
        assert!(matches!(snapshot.state, RemoteConnectionPhase::Connected));
    });
}

#[test]
fn remote_origins_require_tls_except_for_loopback() {
    assert!(normalize_origin("https://example.com/path").is_ok());
    assert!(normalize_origin("http://127.0.0.1:7860").is_ok());
    assert!(normalize_origin("http://192.168.1.20:7860").is_err());
    assert!(normalize_origin("https://user:secret@example.com").is_err());
}

#[test]
fn authorization_request_is_pkce_and_resource_bound() {
    let origin = normalize_origin("https://example.com").unwrap();
    let metadata = OAuthMetadata {
        issuer: "https://example.com/api/auth".into(),
        authorization_endpoint: "https://example.com/api/auth/oauth2/authorize".into(),
        token_endpoint: "https://example.com/api/auth/oauth2/token".into(),
    };
    let url = authorization_url(
        &metadata,
        &origin,
        "http://127.0.0.1:43123/callback",
        "state-value",
        "nonce-value",
        "challenge-value",
    )
    .unwrap();
    let params = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(params.get("client_id").unwrap(), CLIENT_ID);
    assert_eq!(params.get("code_challenge_method").unwrap(), "S256");
    assert!(params
        .get("scope")
        .unwrap()
        .contains("desktop:instance-status:read"));
    assert_eq!(params.get("resource").unwrap(), RESOURCE);
}

#[test]
fn endpoint_mismatch_reports_the_advertised_and_expected_origins() {
    let origin = normalize_origin("https://example.com").unwrap();
    let error = validate_metadata_endpoint(
        &origin,
        "http://example.com/api/auth/oauth2/authorize",
        "authorization endpoint",
    )
    .unwrap_err();
    assert!(error.contains("http://example.com"));
    assert!(error.contains("https://example.com"));
}

#[test]
fn callback_requires_matching_state_and_issuer() {
    let callback = parse_callback_target(
        "/callback?code=abc&state=expected&iss=https%3A%2F%2Fexample.com%2Fapi%2Fauth",
        "expected",
    )
    .unwrap();
    assert_eq!(callback.code, "abc");
    assert_eq!(callback.issuer, "https://example.com/api/auth");
    assert!(parse_callback_target(
        "/callback?code=abc&state=wrong&iss=https%3A%2F%2Fexample.com%2Fapi%2Fauth",
        "expected"
    )
    .is_err());
}

#[test]
fn keyring_account_is_stable_without_revealing_the_origin() {
    let account = keyring_account("https://example.com");
    assert_eq!(account.len(), 64);
    assert!(!account.contains("example"));
    assert_eq!(account, keyring_account("https://example.com"));
}

#[tokio::test]
async fn cancellation_ends_the_callback_wait_and_old_progress_cannot_replace_a_retry() {
    let state = RemoteInstanceState::default();
    let (sender, mut receiver) = tokio::sync::watch::channel(false);
    *state.authorization.lock().unwrap() = Some(AuthorizationAttempt {
        id: "old".into(),
        origin: "https://example.com".into(),
        cancel: sender,
        url: Some("https://example.com/authorize?state=private".into()),
        phase: "callback_pending".into(),
        error: None,
    });
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let task = tokio::spawn(async move {
        tokio::select! { _ = receiver.changed() => {}, _ = await_callback(listener, "state") => panic!("unexpected callback") }
    });
    cancel_attempt(&state, "old");
    task.await.unwrap();
    // The callback future owns the listener. Returning through the cancellation branch drops that future and its
    // listener; probing the released ephemeral port here can race with another parallel loopback test reusing it.
    assert!(!current_attempt(&state, "old"));
    assert!(state
        .authorization
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .url
        .is_none());
    let (sender, _) = tokio::sync::watch::channel(false);
    *state.authorization.lock().unwrap() = Some(AuthorizationAttempt {
        id: "new".into(),
        origin: "https://example.com".into(),
        cancel: sender,
        url: None,
        phase: "preparing".into(),
        error: None,
    });
    progress(&state, "old", "connected", Some("stale".into()), None);
    cancel_attempt(&state, "old");
    assert!(current_attempt(&state, "new"));
    assert_eq!(
        state.authorization.lock().unwrap().as_ref().unwrap().phase,
        "preparing"
    );
}

#[test]
fn denied_callbacks_still_require_state_and_do_not_echo_remote_error_text() {
    let error = parse_callback_target("/callback?error=secret-token&state=wrong", "expected")
        .err()
        .unwrap();
    assert!(error.contains("state"));
    let error = parse_callback_target("/callback?error=secret-token&state=expected", "expected")
        .err()
        .unwrap();
    assert!(error.contains("denied") && !error.contains("secret-token"));
}
