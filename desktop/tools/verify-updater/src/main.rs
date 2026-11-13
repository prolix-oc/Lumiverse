//! CI checks the finalized payload against the public key embedded in releases.
//! Keep this package independent of Tauri so verification cannot rebuild the app.
use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use std::io::Read;
use std::path::Path;

fn verify_folder(folder: &Path, key: &PublicKey) -> Result<usize, Box<dyn std::error::Error>> {
    let mut count = 0;
    for entry in std::fs::read_dir(folder)? {
        let path = entry?.path();
        if path.is_dir() {
            count += verify_folder(&path, key)?;
        } else if path.extension().is_some_and(|extension| extension == "sig") {
            let encoded = std::fs::read_to_string(&path)?;
            let decoded = base64::engine::general_purpose::STANDARD.decode(encoded.trim())?;
            let signature = Signature::decode(std::str::from_utf8(&decoded)?)?;
            let mut verifier = key.verify_stream(&signature)?;
            let mut file = std::fs::File::open(path.with_extension(""))?;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let length = file.read(&mut buffer)?;
                if length == 0 {
                    break;
                }
                verifier.update(&buffer[..length]);
            }
            verifier.finalize()?;
            println!("Verified {}", path.file_name().unwrap().to_string_lossy());
            count += 1;
        }
    }
    Ok(count)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let folder = std::env::args()
        .nth(1)
        .ok_or("Pass the bundle directory.")?;
    let encoded = std::env::var("LUMIVERSE_UPDATER_PUBLIC_KEY")?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(encoded.trim())?;
    let key = PublicKey::decode(std::str::from_utf8(&decoded)?)?;
    if verify_folder(Path::new(&folder), &key)? == 0 {
        return Err("No updater signatures found.".into());
    }
    Ok(())
}
