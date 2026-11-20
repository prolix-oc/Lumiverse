use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

// Public prehashed "test" vector from minisign-verify 0.2.5's verify_stream test.
// These are test data, not the application's release key or signature.
const PUBLIC_KEY: &str = "untrusted comment: minisign public key E7620F1842B4E81F\n\
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3";
const SIGNATURE: &str = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1556193335\tfile:test\n\
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==";
static NEXT_ID: AtomicU64 = AtomicU64::new(0);

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "lumiverse verifier {} {}",
            std::process::id(),
            NEXT_ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn signed_payload(&self, name: &str) {
        let payload = self.0.join(name);
        fs::create_dir_all(payload.parent().unwrap()).unwrap();
        fs::write(payload, b"test").unwrap();
        fs::write(
            self.0.join(format!("{name}.sig")),
            format!(" {}\n", STANDARD.encode(SIGNATURE)),
        )
        .unwrap();
    }

    fn run(&self, key: &str) -> Output {
        Command::new(env!("CARGO_BIN_EXE_lumiverse-verify-updater"))
            .arg(&self.0)
            .env("LUMIVERSE_UPDATER_PUBLIC_KEY", key)
            .output()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn verifies_tauri_encoded_signatures_in_nested_bundle_directories() {
    let fixture = Fixture::new();
    fixture.signed_payload("macos/Lumiverse Desktop.app.tar.gz");
    fixture.signed_payload("appimage/Lumiverse Desktop.AppImage");
    let result = fixture.run(&format!(" {}\n", STANDARD.encode(PUBLIC_KEY)));
    assert!(result.status.success(), "{result:?}");
    let stdout = String::from_utf8(result.stdout).unwrap();
    assert!(stdout.contains("Verified Lumiverse Desktop.app.tar.gz.sig"));
    assert!(stdout.contains("Verified Lumiverse Desktop.AppImage.sig"));
}

#[test]
fn rejects_a_modified_payload() {
    let fixture = Fixture::new();
    fixture.signed_payload("Lumiverse.AppImage");
    fs::write(fixture.0.join("Lumiverse.AppImage"), b"Test").unwrap();
    assert!(!fixture.run(&STANDARD.encode(PUBLIC_KEY)).status.success());
}

#[test]
fn rejects_a_different_public_key() {
    let fixture = Fixture::new();
    fixture.signed_payload("Lumiverse.AppImage");
    let mut key = STANDARD.decode(PUBLIC_KEY.lines().nth(1).unwrap()).unwrap();
    key[10] ^= 1; // Change public key material, preserving its format and key ID.
    let wrong_key = format!(
        "untrusted comment: test public key\n{}",
        STANDARD.encode(key)
    );
    assert!(!fixture.run(&STANDARD.encode(wrong_key)).status.success());
}

#[test]
fn rejects_a_bundle_without_signatures() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("Lumiverse.AppImage"), b"test").unwrap();
    let result = fixture.run(&STANDARD.encode(PUBLIC_KEY));
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("No updater signatures found"));
}

#[test]
fn rejects_a_signature_without_its_payload() {
    let fixture = Fixture::new();
    fixture.signed_payload("Lumiverse.AppImage");
    fs::remove_file(fixture.0.join("Lumiverse.AppImage")).unwrap();
    assert!(!fixture.run(&STANDARD.encode(PUBLIC_KEY)).status.success());
}

#[test]
fn rejects_malformed_signatures() {
    let fixture = Fixture::new();
    fixture.signed_payload("Lumiverse.AppImage");
    for signature in ["not base64!".to_owned(), STANDARD.encode("not a signature")] {
        fs::write(fixture.0.join("Lumiverse.AppImage.sig"), signature).unwrap();
        assert!(!fixture.run(&STANDARD.encode(PUBLIC_KEY)).status.success());
    }
}

#[test]
fn rejects_malformed_public_keys() {
    let fixture = Fixture::new();
    fixture.signed_payload("Lumiverse.AppImage");
    for key in [
        "not base64!".to_owned(),
        STANDARD.encode("not a public key"),
    ] {
        assert!(!fixture.run(&key).status.success());
    }
}
