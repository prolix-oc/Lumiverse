use std::path::PathBuf;
use std::process::Command;

mod release_config;

// Keep native compilation and direct Cargo builds at the same minimum as
// bundle.macOS.minimumSystemVersion in tauri.conf.json. Tauri only supplies the
// deployment target itself when invoked through its CLI or for release builds.
const MACOS_MINIMUM_SYSTEM_VERSION: &str = "13.0";

fn git_output(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// Stamp the commit this shell was compiled from.
///
/// The tray is a compiled binary living outside the checkout, so the runner's
/// git update flow cannot replace it the way it replaces server and frontend
/// code. Without a build stamp there is nothing to compare a moved checkout
/// against, and a shell that is several releases behind looks exactly like one
/// that is current.
fn stamp_build_revision() {
    let sha = git_output(&["rev-parse", "HEAD"]);

    // Builds from a source archive have no git metadata. Stamp an empty
    // revision rather than failing the build — the tray reads that as "cannot
    // tell" and stays silent instead of guessing.
    println!(
        "cargo:rustc-env=LUMIVERSE_DESKTOP_SHA={}",
        sha.clone().unwrap_or_default()
    );

    // Once a build script emits any rerun-if-changed, Cargo reruns it *only*
    // when those paths change. So the paths must be ones a fast-forward pull
    // actually touches. `.git/HEAD` is not one of them — on a branch it holds
    // `ref: refs/heads/<name>` and is untouched by a pull — and neither is the
    // `refs/` directory, whose mtime does not change when a file nested below
    // it is rewritten. Getting this wrong stamps the *previous* revision into
    // a binary compiled from new sources, which then reports itself stale.
    //
    // `index` is rewritten by every checkout and reset, including the runner's
    // `reset --hard` to upstream. Together with HEAD (branch switches) and
    // packed-refs (post-gc ref storage) it covers how a checkout moves.
    // Resolve the git dir rather than assuming `../../.git`, so a worktree —
    // where `.git` is a file pointing elsewhere — still gets real paths.
    if sha.is_some() {
        if let Some(git_dir) = git_output(&["rev-parse", "--git-dir"]) {
            let git_dir = PathBuf::from(git_dir);
            for entry in ["HEAD", "index", "packed-refs"] {
                println!("cargo:rerun-if-changed={}", git_dir.join(entry).display());
            }
        }
    }
}

fn validate_release_config() {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    println!("cargo:rerun-if-changed=release_config.rs");
    if tauri_build::is_dev() {
        return;
    }
    // Match Tauri's config loading: base + platform config, then the CLI's
    // merged --config overrides. Private builders carry the public key here.
    let target = tauri_utils::platform::Target::from_triple(&std::env::var("TARGET").unwrap());
    let (mut config, paths) =
        tauri_utils::config::parse::read_from(target, &std::env::current_dir().unwrap())
            .expect("failed to read desktop release configuration");
    for path in paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    if let Ok(overrides) = std::env::var("TAURI_CONFIG") {
        let overrides = serde_json::from_str(&overrides).expect("invalid TAURI_CONFIG");
        json_patch::merge(&mut config, &overrides);
    }
    release_config::validate(&config).expect("invalid desktop release configuration");
}

fn main() {
    validate_release_config();
    println!(
        "cargo:rustc-env=LUMIVERSE_DESKTOP_TARGET={}",
        std::env::var("TARGET").unwrap()
    );
    stamp_build_revision();
    println!("cargo:rerun-if-changed=src/capture/macos.m");
    println!("cargo:rerun-if-changed=src/system_audio/coreaudio.m");
    println!("cargo:rerun-if-changed=src/popup_close.m");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET={MACOS_MINIMUM_SYSTEM_VERSION}");
        let mut capture = cc::Build::new();
        capture
            .env("MACOSX_DEPLOYMENT_TARGET", MACOS_MINIMUM_SYSTEM_VERSION)
            .file("src/capture/macos.m")
            .file("src/system_audio/coreaudio.m")
            .file("src/popup_close.m")
            .flag("-fobjc-arc")
            .flag("-fblocks")
            .compile("lumiverse_capture");
        let runtime = capture
            .get_compiler()
            .to_command()
            .arg("--print-file-name=libclang_rt.osx.a")
            .output()
            .expect("failed to locate the Clang macOS runtime");
        assert!(
            runtime.status.success(),
            "Clang macOS runtime lookup failed"
        );
        let runtime_path = PathBuf::from(
            std::str::from_utf8(&runtime.stdout)
                .expect("Clang macOS runtime path is not UTF-8")
                .trim(),
        );
        assert!(
            runtime_path.is_file(),
            "Clang macOS runtime archive not found: {}",
            runtime_path.display()
        );
        println!(
            "cargo:rustc-link-search=native={}",
            runtime_path.parent().unwrap().display()
        );
        println!("cargo:rustc-link-lib=static=clang_rt.osx");
        for framework in [
            "Cocoa",
            "WebKit",
            "CoreGraphics",
            "AVFoundation",
            "CoreAudio",
            "AVKit",
            "VideoToolbox",
            "CoreMedia",
            "CoreVideo",
        ] {
            println!("cargo:rustc-link-lib=framework={framework}");
        }
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,ScreenCaptureKit");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "desktop_capture_connect",
            "desktop_keybindings_show",
            "desktop_keybindings_get",
            "desktop_keybindings_save",
            "desktop_keybindings_publish",
            "desktop_keybindings_trigger",
            "desktop_keybindings_frontend_get",
            "desktop_keybindings_frontend_save",
            "desktop_keybindings_global_permission",
            "desktop_keybindings_editing",
            "desktop_capture_disconnect",
            "desktop_capture_status",
            "desktop_capture_request_setup",
            "desktop_capture_setup_finished",
            "desktop_capture_reset_approvals",
            "bundled_server_available",
            "bundled_server_start",
            "bundled_server_stop",
            "bundled_server_status",
            "bundled_server_alive",
            "bundled_server_network_access",
            "bundled_server_set_network_access",
            "bundled_setup_defaults",
            "bundled_setup_save",
            "bundled_setup_status",
            "bundled_setup_complete",
            "bundled_setup_pick_folder",
            "desktop_profile_info",
            "open_external_url",
            "reveal_desktop_artifact",
            "linux_diagnostics",
            "save_linux_graphics",
            "show_linux_settings",
            "desktop_smoke_complete",
            "remote_authorization_status",
            "remote_authorization_cancel",
            "remote_authorization_retry",
            "open_lumiverse_data_folder",
            "desktop_update_info",
            "desktop_update_check",
            "desktop_update_download",
            "desktop_update_install",
        ]),
    ))
    .expect("failed to build desktop permissions")
}
