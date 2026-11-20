//! Native transport recovery is independent of the frontend document and tray rendering.
use super::{bounded_json, displays::Display, verify_account, Capabilities, Commands, Registration, Session, API_PATH};
use reqwest::Client;
use std::{future::Future, sync::atomic::Ordering, time::Duration};

pub(super) async fn maintain_connection<F, Attempt>(session: &Session, retry_delay: Duration, mut attempt: F)
where
    F: FnMut() -> Attempt,
    Attempt: Future<Output = Result<(), ()>>,
{
    while !session.stopped.load(Ordering::SeqCst) {
        // Each attempt owns its lease and cancels unfinished capture before returning.
        let _ = attempt().await;
        if session.stopped.load(Ordering::SeqCst) { return; }
        *session.error.lock().unwrap() = Some(
            "Capture disconnected. Desktop will retry while screen capture is enabled.".into(),
        );
        tokio::select! {
            biased;
            _ = session.wake.notified() => return,
            _ = tokio::time::sleep(retry_delay) => {},
        }
    }
}

pub(super) struct Connection {
    pub endpoint: String,
    pub lease: String,
    published_displays: Option<Vec<Display>>,
}

impl Connection {
    pub async fn register(client: &Client, origin: &str, token: &str, account_id: &str, device_key: &str, capabilities: Capabilities) -> Result<Self, ()> {
        verify_account(client, origin, token, account_id).await?;
        let register = client.post(format!("{origin}{API_PATH}")).bearer_auth(token)
            .json(&serde_json::json!({"name":"Lumiverse Desktop","platform":std::env::consts::OS,"capabilities":capabilities,"deviceKey":device_key,"approvalStatus":true,"recordingControl":true}));
        let registration: Registration = bounded_json(register.send().await.map_err(|_| ())?, 4096).await?;
        if uuid::Uuid::parse_str(&registration.device.id).is_err()
            || registration.transport_token.len() > 256 || registration.transport_token.len() < 32 {
            return Err(());
        }
        Ok(Self {
            endpoint: format!("{origin}{API_PATH}/{}", registration.device.id),
            lease: registration.transport_token,
            published_displays: None,
        })
    }

    pub async fn commands(&mut self, client: &Client, token: &str, displays: &[Display]) -> Result<Commands, ()> {
        if self.published_displays.as_deref() != Some(displays) {
            let response = client.post(format!("{}/displays", self.endpoint)).bearer_auth(token)
                .header("X-Lumiverse-Capture-Lease", &self.lease).json(displays).send().await.map_err(|_| ())?;
            // Older instances still support the native picker.
            if !response.status().is_success() && response.status().as_u16() != 404 { return Err(()); }
            self.published_displays = Some(displays.to_vec());
        }
        let response = client.get(format!("{}/commands", self.endpoint)).bearer_auth(token)
            .header("X-Lumiverse-Capture-Lease", &self.lease).send().await.map_err(|_| ())?;
        bounded_json(response, 32 * 1024).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener, time::timeout};

    const DEVICE: &str = "00000000-0000-5000-a000-000000000001";
    const DEVICE_KEY: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const LEASE_A: &str = "11111111111111111111111111111111";
    const LEASE_B: &str = "22222222222222222222222222222222";
    const CAPS: Capabilities = Capabilities { image: true, video: true, replay: false };

    struct Reply {
        method: &'static str,
        path: String,
        lease: Option<&'static str>,
        status: u16,
        body: serde_json::Value,
    }

    fn me(account: &str, status: u16) -> Reply {
        Reply { method: "GET", path: "/api/desktop/v1/me".into(), lease: None, status,
            body: serde_json::json!({"account":{"id":account,"name":"Owner"}}) }
    }

    fn register(lease: &'static str) -> Reply {
        Reply { method: "POST", path: API_PATH.into(), lease: None, status: 200,
            body: serde_json::json!({"device":{"id":DEVICE},"transportToken":lease}) }
    }

    fn command_reply(method: &'static str, path: &str, lease: &'static str, status: u16, body: serde_json::Value) -> Reply {
        Reply { method, path: format!("{API_PATH}/{DEVICE}/{path}"), lease: Some(lease), status, body }
    }

    async fn server(replies: Vec<Reply>) -> (String, tauri::async_runtime::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let task = tauri::async_runtime::spawn(async move {
            let mut requests = Vec::new();
            for reply in replies {
                let (mut stream, _) = timeout(Duration::from_secs(5), listener.accept()).await.unwrap().unwrap();
                let mut request = Vec::new();
                let header_end = loop {
                    let mut chunk = [0; 4096];
                    let count = timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.unwrap().unwrap();
                    assert!(count > 0 && request.len() + count < 32768);
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") { break end + 4; }
                };
                let headers = String::from_utf8(request[..header_end].to_vec()).unwrap().to_lowercase();
                assert!(headers.starts_with(&format!("{} {} http/1.1\r\n", reply.method.to_lowercase(), reply.path)));
                assert!(headers.contains("\r\nauthorization: bearer test-token\r\n"));
                if let Some(lease) = reply.lease { assert!(headers.contains(&format!("\r\nx-lumiverse-capture-lease: {lease}\r\n"))); }
                let content_length = headers.lines().find_map(|line| line.strip_prefix("content-length: "))
                    .map(|value| value.parse::<usize>().unwrap()).unwrap_or(0);
                while request.len() < header_end + content_length {
                    let mut chunk = [0; 4096];
                    let count = timeout(Duration::from_secs(5), stream.read(&mut chunk)).await.unwrap().unwrap();
                    assert!(count > 0 && request.len() + count < 32768);
                    request.extend_from_slice(&chunk[..count]);
                }
                requests.push(request[header_end..].to_vec());
                let body = reply.body.to_string();
                let response = format!("HTTP/1.1 {} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", reply.status, body.len());
                stream.write_all(response.as_bytes()).await.unwrap();
            }
            requests
        });
        (origin, task)
    }

    #[test]
    fn server_restart_recovers_a_fresh_lease_and_republishes_displays_without_a_frontend() {
        tauri::async_runtime::block_on(async {
            let (origin, server) = server(vec![
                me("alice", 200), register(LEASE_A),
                command_reply("POST", "displays", LEASE_A, 200, serde_json::json!({"ok":true})),
                command_reply("GET", "commands", LEASE_A, 200, serde_json::json!({"commands":[]})),
                command_reply("GET", "commands", LEASE_A, 401, serde_json::json!({"code":"INVALID_DEVICE_LEASE"})),
                me("alice", 503), // The next connection attempt still hits the restart.
                me("alice", 200), register(LEASE_B),
                command_reply("POST", "displays", LEASE_B, 200, serde_json::json!({"ok":true})),
                command_reply("GET", "commands", LEASE_B, 200, serde_json::json!({"commands":[{"type":"cancel","requestId":"new-request"}]})),
            ]).await;
            let session = Session::new(origin.clone());
            let client = Client::builder().no_proxy().timeout(Duration::from_secs(2)).build().unwrap();
            let attempts = AtomicUsize::new(0);
            let displays = vec![Display {
                id: DEVICE_KEY.into(), name: "Display 1".into(), width: 1920, height: 1080,
                primary: true, identity: "private-monitor-identity".into(),
            }];
            timeout(Duration::from_secs(5), maintain_connection(&session, Duration::from_millis(1), || async {
                let attempt = attempts.fetch_add(1, Ordering::SeqCst);
                let mut connection = Connection::register(&client, &origin, "test-token", "alice", DEVICE_KEY, CAPS).await?;
                let commands = connection.commands(&client, "test-token", &displays).await?;
                if attempt == 0 {
                    assert!(commands.commands.is_empty());
                    return connection.commands(&client, "test-token", &displays).await.map(|_| ());
                }
                assert_eq!(attempt, 2);
                assert!(session.error.lock().unwrap().is_some());
                assert!(matches!(&commands.commands[..], [super::super::Command::Cancel { request_id }] if request_id == "new-request"));
                session.stop();
                Ok(())
            })).await.unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), 3);
            let requests = server.await.unwrap();
            let first: serde_json::Value = serde_json::from_slice(&requests[1]).unwrap();
            let second: serde_json::Value = serde_json::from_slice(&requests[7]).unwrap();
            assert_eq!(first["deviceKey"], DEVICE_KEY);
            assert_eq!(first, second);
            assert_eq!(requests[2], requests[8]); // Monitor metadata is republished for the new lease.
        });
    }

    #[test]
    fn reconnect_cannot_register_as_a_different_account() {
        tauri::async_runtime::block_on(async {
            let (origin, server) = server(vec![me("bob", 200)]).await;
            let client = Client::builder().no_proxy().build().unwrap();
            assert!(Connection::register(&client, &origin, "test-token", "alice", DEVICE_KEY, CAPS).await.is_err());
            assert_eq!(server.await.unwrap().len(), 1);
        });
    }

    #[test]
    fn disable_during_retry_wakes_immediately_and_never_registers_again() {
        tauri::async_runtime::block_on(async {
            let session = Arc::new(Session::new("https://instance".into()));
            let attempts = Arc::new(AtomicUsize::new(0));
            let attempted = Arc::new(tokio::sync::Notify::new());
            let runner = {
                let session = session.clone(); let attempts = attempts.clone(); let attempted = attempted.clone();
                tauri::async_runtime::spawn(async move {
                    maintain_connection(&session, Duration::from_secs(3600), || async {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        attempted.notify_one();
                        Err(())
                    }).await;
                })
            };
            attempted.notified().await;
            session.stop();
            timeout(Duration::from_secs(1), runner).await.unwrap().unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
            maintain_connection(&session, Duration::ZERO, || async { panic!("A stopped session must never reconnect") }).await;
        });
    }
}
