//! Platforms without a system-audio adapter. The tray cannot switch the feature on and `start` always fails, so
//! `ctx.systemAudio.isAvailable()` reports `unsupported`.

#![allow(dead_code)]

use super::analyzer::Frame;
pub use super::engine::{Capture, Exit, Options};

pub fn supported() -> bool {
    false
}

pub fn start(
    _options: Options,
    _on_frame: impl FnMut(&Frame) -> bool + Send + 'static,
    _on_end: impl FnOnce(Exit) + Send + 'static,
) -> Result<Capture, String> {
    Err("System audio analysis is not available on this OS yet".into())
}
