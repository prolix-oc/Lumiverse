//! macOS system-audio capture: a Core Audio process tap on everything the device plays (macOS 14.2+).
//!
//! The device itself is `coreaudio.m`; this file adapts it to the shared engine. *When* to work (silence, hidden
//! window, pacing) is `engine.rs`. A hidden window stops the tap's IO outright, so nothing runs while nobody looks.
//!
//! macOS asks the user for "System Audio Recording" the first time a tap is created. If that is refused, opening the
//! tap fails and `start` says so; Lumiverse never requests Screen Recording for this feature.

use std::{ffi::c_void, thread, time::Duration};

pub use super::engine::{Capture, Exit, Options};
use super::{
    analyzer::{Analyzer, Frame},
    engine::{spawn, Device, Fault, Session},
};

extern "C" {
    fn lumiverse_audio_tap_available() -> bool;
    fn lumiverse_audio_tap_open(status: *mut i32, stereo: bool) -> *mut c_void;
    fn lumiverse_audio_tap_sample_rate(handle: *mut c_void) -> u32;
    fn lumiverse_audio_tap_set_running(handle: *mut c_void, run: bool) -> bool;
    fn lumiverse_audio_tap_read(handle: *mut c_void, out: *mut f32, capacity: usize) -> usize;
    fn lumiverse_audio_tap_output_changed(handle: *mut c_void) -> bool;
    fn lumiverse_audio_tap_close(handle: *mut c_void);
    fn lumiverse_audio_watch_open() -> *mut c_void;
    fn lumiverse_audio_watch_tripped(handle: *mut c_void) -> bool;
    fn lumiverse_audio_watch_close(handle: *mut c_void);
}

const REOPEN_TRIES: u32 = 6;
const REOPEN_WAIT: Duration = Duration::from_millis(500);
/// Samples copied per read; a drain loops until the ring is empty.
const READ_CHUNK: usize = 4096;

/// Whether this macOS has process taps (14.2 and later). Cheap and side-effect free.
pub fn supported() -> bool {
    unsafe { lumiverse_audio_tap_available() }
}

fn describe(status: i32) -> String {
    match status {
        1 => "System audio needs macOS 14.2 or later".into(),
        2 => "No audio output device is available".into(),
        3 | 4 | 6 => "macOS did not let Lumiverse listen to system audio. Allow Lumiverse under System Settings > \
            Privacy & Security > Screen & System Audio Recording > System Audio Recording Only, then try again"
            .into(),
        5 => "This Mac's output uses an audio format Lumiverse cannot read".into(),
        _ => "Could not listen to system audio".into(),
    }
}

struct Tap {
    handle: *mut c_void,
    running: bool,
    scratch: Vec<f32>,
    channels: usize,
}

impl Tap {
    fn open(stereo: bool) -> Result<Self, String> {
        let mut status = 0i32;
        let handle = unsafe { lumiverse_audio_tap_open(&mut status, stereo) };
        if handle.is_null() {
            return Err(describe(status));
        }
        Ok(Self {
            handle,
            running: false,
            scratch: vec![0.0; READ_CHUNK],
            channels: if stereo { 2 } else { 1 },
        })
    }

    fn set_running(&mut self, run: bool) -> bool {
        if run == self.running {
            return true;
        }
        let done = unsafe { lumiverse_audio_tap_set_running(self.handle, run) };
        if done {
            self.running = run;
        }
        done
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        unsafe { lumiverse_audio_tap_close(self.handle) };
    }
}

impl Device for Tap {
    fn sample_rate(&self) -> u32 {
        unsafe { lumiverse_audio_tap_sample_rate(self.handle) }
    }

    fn drain(&mut self, analyzer: &mut Analyzer, discard: bool) -> Result<f32, Fault> {
        if discard {
            // Hidden: stop the IO itself, so there are no callbacks until the window is back.
            self.set_running(false);
            return Ok(0.0);
        }
        if !self.set_running(true) {
            return Err(Fault::Failed);
        }
        if unsafe { lumiverse_audio_tap_output_changed(self.handle) } {
            return Err(Fault::Gone);
        }
        let mut loudest = 0.0f32;
        loop {
            let count = unsafe {
                lumiverse_audio_tap_read(self.handle, self.scratch.as_mut_ptr(), self.scratch.len())
            };
            if count == 0 {
                break;
            }
            for sample in &mut self.scratch[..count] {
                if !sample.is_finite() {
                    *sample = 0.0;
                }
                loudest = loudest.max(sample.abs());
            }
            analyzer.push(&self.scratch[..count], self.channels);
            if count < self.scratch.len() {
                break;
            }
        }
        Ok(loudest)
    }
}

/// Lock, user switching and sleep, as notified by the system.
struct Watch(*mut c_void);

impl Watch {
    fn open() -> Self {
        Self(unsafe { lumiverse_audio_watch_open() })
    }
    fn tripped(&self) -> bool {
        unsafe { lumiverse_audio_watch_tripped(self.0) }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        unsafe { lumiverse_audio_watch_close(self.0) };
    }
}

/// Start listening to everything the device plays on a dedicated thread. See `engine::spawn`.
pub fn start(
    options: Options,
    on_frame: impl FnMut(&Frame) -> bool + Send + 'static,
    on_end: impl FnOnce(Exit) + Send + 'static,
) -> Result<Capture, String> {
    if !supported() {
        return Err(describe(1));
    }
    let stereo = options.stereo;
    spawn(
        options,
        move || {
            let watch = Watch::open();
            let device = Tap::open(stereo)?;
            Ok(Session {
                device,
                reopen: Box::new(move |stop| {
                    for _ in 0..REOPEN_TRIES {
                        thread::sleep(REOPEN_WAIT);
                        if stop.load(std::sync::atomic::Ordering::Relaxed) {
                            return None;
                        }
                        if let Ok(tap) = Tap::open(stereo) {
                            return Some(tap);
                        }
                    }
                    None
                }),
                interrupted: Box::new(move || watch.tripped()),
                keep: Box::new(()),
            })
        },
        on_frame,
        on_end,
    )
}
