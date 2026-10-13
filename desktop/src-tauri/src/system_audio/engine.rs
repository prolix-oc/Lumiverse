//! The platform-independent half of a polling adapter (Windows WASAPI, macOS Core Audio).
//!
//! A platform supplies a [`Device`] that can hand over whatever audio is waiting, plus two small hooks (reopen the
//! device after it went away, and "has the machine locked or gone to sleep"). Everything about *when* to work lives
//! here, because that is what decides how much hardware an adapter uses:
//!
//! - **Silence costs almost nothing.** After [`Timings::silence_hold`] without sound the engine sends one zero frame,
//!   drops its analysis, and only wakes [`Timings::idle`] apart to look for new audio.
//! - **Sound costs one FFT per emitted mono frame**, or three with stereo, and nothing between frames.
//! - **A hidden window costs a drain**: audio is released without being decoded, and nothing is sent.
//! - The thread never sleeps longer than [`Timings::max_wait`], so a stop request is honoured promptly.
//!
//! Capture ends on owner stop, on lock or suspend, on a device that cannot be recovered, and when the page stops
//! listening. Samples never leave this thread; only [`Frame`]s do.

use std::{
    any::Any,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use super::analyzer::{Analyzer, Frame};

/// Why a capture ended by itself.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Exit {
    /// The owner asked, or the frontend stopped listening.
    Stopped,
    /// Lock, suspend, or a device that could not be recovered.
    Lost,
}

/// What went wrong while draining a device.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fault {
    /// The device went away (default output changed, driver restart). Worth reopening.
    Gone,
    /// Anything else. Not recoverable.
    #[cfg(any(target_os = "windows", target_os = "macos", test))]
    Failed,
}

#[derive(Clone, Copy)]
pub struct Timings {
    pub idle: Duration,
    pub paused: Duration,
    pub max_wait: Duration,
    pub silence_hold: Duration,
    pub guard_every: Duration,
    /// About -80 dBFS.
    pub audible: f32,
}

impl Default for Timings {
    fn default() -> Self {
        Self {
            idle: Duration::from_millis(100),
            paused: Duration::from_millis(250),
            max_wait: Duration::from_millis(250),
            silence_hold: Duration::from_millis(500),
            guard_every: Duration::from_millis(500),
            audible: 1e-4,
        }
    }
}

pub struct Options {
    pub interval: Duration,
    /// Set while the frontend window is hidden or minimised.
    pub paused: Arc<AtomicBool>,
    pub timings: Timings,
    pub stereo: bool,
}

impl Options {
    pub fn new(interval: Duration, paused: Arc<AtomicBool>) -> Self {
        Self {
            interval,
            paused,
            timings: Timings::default(),
            stereo: false,
        }
    }

    pub fn with_stereo(mut self, stereo: bool) -> Self {
        self.stereo = stereo;
        self
    }
}

pub trait Device {
    fn sample_rate(&self) -> u32;
    /// Move every waiting packet into `analyzer`, or just release it when `discard`. Returns the loudest absolute
    /// sample seen: 0 for no audio or for audio flagged silent.
    fn drain(&mut self, analyzer: &mut Analyzer, discard: bool) -> Result<f32, Fault>;
}

/// Everything a platform builds on the capture thread. (Device handles are often not `Send`, so this is made there.)
pub struct Session<D> {
    pub device: D,
    /// Open the device again after it went away. Gets the stop flag so a long retry can give up.
    pub reopen: Box<dyn FnMut(&AtomicBool) -> Option<D>>,
    /// True once the machine has locked or is going to sleep.
    pub interrupted: Box<dyn FnMut() -> bool>,
    /// Anything that must outlive the device and drop after it (for example COM initialisation).
    pub keep: Box<dyn Any>,
}

pub struct Capture {
    stop: Arc<AtomicBool>,
}

impl Capture {
    /// Ask the thread to finish. It owns every device handle and releases them on its way out, so there is nothing to
    /// join and nothing for a new session to wait on.
    pub fn stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        self.stop();
    }
}

const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

/// Run `setup` on a new thread, wait for it to open the device, then analyse on that thread until something ends it.
///
/// Blocks until the device is open (or has failed to), so call it from a blocking context. `on_frame` returns false
/// when nobody is listening any more. `on_end` runs once, on the capture thread, after the device has been released.
pub fn spawn<D: Device + 'static>(
    options: Options,
    setup: impl FnOnce() -> Result<Session<D>, String> + Send + 'static,
    mut on_frame: impl FnMut(&Frame) -> bool + Send + 'static,
    on_end: impl FnOnce(Exit) + Send + 'static,
) -> Result<Capture, String> {
    let stop = Arc::new(AtomicBool::new(false));
    let flag = stop.clone();
    let (ready, opened) = mpsc::sync_channel::<Result<(), String>>(1);
    thread::Builder::new()
        .name("lumiverse-system-audio".into())
        .spawn(move || {
            let session = match setup() {
                Ok(session) => session,
                Err(error) => {
                    let _ = ready.send(Err(error));
                    return;
                }
            };
            let _ = ready.send(Ok(()));
            // A panic must still reach `on_end`, or the tray would show "in use" for a session that is long gone.
            let exit = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                run(session, &flag, &options, &mut on_frame)
            }))
            .unwrap_or(Exit::Lost);
            on_end(exit);
        })
        .map_err(|_| "Could not start the system audio thread".to_string())?;
    match opened.recv_timeout(OPEN_TIMEOUT) {
        Ok(Ok(())) => Ok(Capture { stop }),
        Ok(Err(error)) => Err(error),
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err("The audio device took too long to open".into())
        }
    }
}

fn pause(duration: Duration, timings: &Timings) {
    thread::sleep(duration.min(timings.max_wait));
}

fn run<D: Device>(
    session: Session<D>,
    stop: &AtomicBool,
    options: &Options,
    on_frame: &mut impl FnMut(&Frame) -> bool,
) -> Exit {
    let Session {
        mut device,
        mut reopen,
        mut interrupted,
        keep,
    } = session;
    let exit = poll(
        &mut device,
        &mut reopen,
        &mut interrupted,
        stop,
        options,
        on_frame,
    );
    // Device first, then whatever it depended on.
    drop(device);
    drop(reopen);
    drop(interrupted);
    drop(keep);
    exit
}

fn poll<D: Device>(
    device: &mut D,
    reopen: &mut dyn FnMut(&AtomicBool) -> Option<D>,
    interrupted: &mut dyn FnMut() -> bool,
    stop: &AtomicBool,
    options: &Options,
    on_frame: &mut impl FnMut(&Frame) -> bool,
) -> Exit {
    let timings = &options.timings;
    let mut analyzer = Analyzer::with_stereo(device.sample_rate(), options.stereo);
    let mut frame = Frame::default();
    let mut active = false;
    let (mut last_sound, mut next_frame, mut last_guard) =
        (Instant::now(), Instant::now(), Instant::now());

    loop {
        if stop.load(Ordering::Relaxed) {
            return Exit::Stopped;
        }
        let now = Instant::now();
        if now.duration_since(last_guard) >= timings.guard_every {
            last_guard = now;
            if interrupted() {
                return Exit::Lost;
            }
        }

        let paused = options.paused.load(Ordering::Relaxed);
        let loudest = match device.drain(&mut analyzer, paused) {
            Ok(loudest) => loudest,
            Err(Fault::Gone) => {
                // The default output changed (headphones, a dock, a driver restart). Follow it quietly: the user
                // approved listening to system audio, not to one particular device.
                match reopen(stop) {
                    Some(reopened) => {
                        analyzer = Analyzer::with_stereo(reopened.sample_rate(), options.stereo);
                        *device = reopened;
                        active = false;
                        continue;
                    }
                    None if stop.load(Ordering::Relaxed) => return Exit::Stopped,
                    None => return Exit::Lost,
                }
            }
            #[cfg(any(target_os = "windows", target_os = "macos", test))]
            Err(Fault::Failed) => return Exit::Lost,
        };

        if paused {
            if active {
                active = false;
                analyzer.clear();
            }
            pause(timings.paused, timings);
            continue;
        }

        if loudest > timings.audible {
            last_sound = now;
            if !active {
                active = true;
                next_frame = now;
            }
        }
        if !active {
            pause(timings.idle, timings);
            continue;
        }

        if now.duration_since(last_sound) > timings.silence_hold {
            // Sound stopped: one clean zero frame so the visual settles, then back to idle.
            active = false;
            analyzer.clear();
            if !on_frame(&Frame::silence(options.stereo)) {
                return Exit::Stopped;
            }
            continue;
        }
        if now >= next_frame {
            if analyzer.analyse(&mut frame) && !on_frame(&frame) {
                return Exit::Stopped;
            }
            next_frame = (next_frame + options.interval).max(now);
        }
        pause(
            next_frame.saturating_duration_since(Instant::now()),
            timings,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Mutex};

    const RATE: u32 = 48_000;

    /// A device the test drives by hand.
    #[derive(Clone, Default)]
    struct Knobs {
        loud: Arc<AtomicBool>,
        gone: Arc<AtomicBool>,
        fail: Arc<AtomicBool>,
        panic: Arc<AtomicBool>,
        drains: Arc<AtomicUsize>,
        discards: Arc<AtomicUsize>,
        reopens: Arc<AtomicUsize>,
        reopen_works: Arc<AtomicBool>,
        locked: Arc<AtomicBool>,
        phase: Arc<Mutex<f32>>,
    }

    struct Fake(Knobs);

    impl Device for Fake {
        fn sample_rate(&self) -> u32 {
            RATE
        }
        fn drain(&mut self, analyzer: &mut Analyzer, discard: bool) -> Result<f32, Fault> {
            let k = &self.0;
            k.drains.fetch_add(1, Ordering::SeqCst);
            if k.panic.load(Ordering::SeqCst) {
                panic!("driver blew up");
            }
            if k.fail.load(Ordering::SeqCst) {
                return Err(Fault::Failed);
            }
            if k.gone.swap(false, Ordering::SeqCst) {
                return Err(Fault::Gone);
            }
            if discard {
                k.discards.fetch_add(1, Ordering::SeqCst);
                return Ok(0.0);
            }
            if !k.loud.load(Ordering::SeqCst) {
                return Ok(0.0);
            }
            let mut phase = k.phase.lock().unwrap();
            let samples: Vec<f32> = (0..1024)
                .map(|_| {
                    *phase += 2.0 * std::f32::consts::PI * 440.0 / RATE as f32;
                    0.3 * phase.sin()
                })
                .collect();
            analyzer.push(&samples, 1);
            Ok(0.3)
        }
    }

    fn fast() -> Timings {
        Timings {
            idle: Duration::from_millis(5),
            paused: Duration::from_millis(5),
            max_wait: Duration::from_millis(5),
            silence_hold: Duration::from_millis(120),
            guard_every: Duration::from_millis(5),
            audible: 1e-4,
        }
    }

    struct Rig {
        knobs: Knobs,
        paused: Arc<AtomicBool>,
        frames: Arc<Mutex<Vec<Frame>>>,
        ended: mpsc::Receiver<Exit>,
        capture: Capture,
    }

    fn start(knobs: Knobs, listening: bool) -> Rig {
        start_mode(knobs, listening, false)
    }

    fn start_mode(knobs: Knobs, listening: bool, stereo: bool) -> Rig {
        let paused = Arc::new(AtomicBool::new(false));
        let frames = Arc::new(Mutex::new(Vec::new()));
        let (tx, ended) = mpsc::channel();
        let setup_knobs = knobs.clone();
        let sink = frames.clone();
        let capture = spawn(
            Options {
                interval: Duration::from_millis(10),
                paused: paused.clone(),
                timings: fast(),
                stereo,
            },
            move || {
                let (reopen_knobs, lock_knobs) = (setup_knobs.clone(), setup_knobs.clone());
                Ok(Session {
                    device: Fake(setup_knobs),
                    reopen: Box::new(move |_| {
                        reopen_knobs.reopens.fetch_add(1, Ordering::SeqCst);
                        reopen_knobs
                            .reopen_works
                            .load(Ordering::SeqCst)
                            .then(|| Fake(reopen_knobs.clone()))
                    }),
                    interrupted: Box::new(move || lock_knobs.locked.load(Ordering::SeqCst)),
                    keep: Box::new(()),
                })
            },
            move |frame| {
                sink.lock().unwrap().push(frame.clone());
                listening
            },
            move |exit| {
                let _ = tx.send(exit);
            },
        )
        .expect("starts");
        Rig {
            knobs,
            paused,
            frames,
            ended,
            capture,
        }
    }

    fn settle(ms: u64) {
        thread::sleep(Duration::from_millis(ms));
    }
    fn count(rig: &Rig) -> usize {
        rig.frames.lock().unwrap().len()
    }
    fn exit_of(rig: &Rig) -> Option<Exit> {
        rig.ended.recv_timeout(Duration::from_secs(2)).ok()
    }

    #[test]
    fn nothing_playing_sends_nothing_and_barely_wakes() {
        let rig = start(Knobs::default(), true);
        settle(150);
        assert_eq!(count(&rig), 0);
        rig.capture.stop();
        assert_eq!(exit_of(&rig), Some(Exit::Stopped));
    }

    #[test]
    fn stereo_mode_survives_device_reopen_and_emits_complete_silence() {
        let rig = start_mode(Knobs::default(), true, true);
        rig.knobs.loud.store(true, Ordering::SeqCst);
        settle(150);
        assert!(rig
            .frames
            .lock()
            .unwrap()
            .iter()
            .any(|f| f
                .stereo
                .as_ref()
                .is_some_and(|s| s.left.amplitude > 0.0 && s.right.amplitude > 0.0)));
        rig.knobs.reopen_works.store(true, Ordering::SeqCst);
        rig.knobs.gone.store(true, Ordering::SeqCst);
        settle(150);
        assert!(rig.knobs.reopens.load(Ordering::SeqCst) > 0);
        assert!(rig
            .frames
            .lock()
            .unwrap()
            .iter()
            .all(|f| f.stereo.is_some()));
        rig.knobs.loud.store(false, Ordering::SeqCst);
        settle(400);
        let last = rig.frames.lock().unwrap().last().cloned().unwrap();
        let stereo = last.stereo.unwrap();
        assert_eq!(
            (
                last.amplitude,
                stereo.left.amplitude,
                stereo.right.amplitude
            ),
            (0.0, 0.0, 0.0)
        );
        assert_eq!((stereo.left.peak, stereo.right.peak), (0.0, 0.0));
        assert!(stereo
            .left
            .bands
            .iter()
            .chain(&stereo.right.bands)
            .all(|&v| v == 0.0));
        rig.capture.stop();
        assert_eq!(exit_of(&rig), Some(Exit::Stopped));
    }

    #[test]
    fn sound_produces_frames_at_roughly_the_requested_rate_then_one_zero_frame() {
        let rig = start(Knobs::default(), true);
        rig.knobs.loud.store(true, Ordering::SeqCst);
        settle(400);
        let during = count(&rig);
        // 10 ms interval over ~400 ms, minus the time to fill the first window: a loose band, not a benchmark.
        assert!((8..=45).contains(&during), "{during} frames");
        assert!(rig
            .frames
            .lock()
            .unwrap()
            .iter()
            .any(|f| f.bands.iter().any(|&b| b > 0.0)));

        rig.knobs.loud.store(false, Ordering::SeqCst);
        settle(500);
        let after = count(&rig);
        assert!(after >= during + 1, "the zero frame was not sent");
        let last = rig.frames.lock().unwrap().last().cloned().unwrap();
        assert_eq!((last.amplitude, last.peak), (0.0, 0.0));
        assert!(last.bands.iter().all(|&b| b == 0.0));
        // And then it goes quiet again: only the one zero frame came after the sound stopped.
        settle(200);
        assert_eq!(count(&rig), after);
        rig.capture.stop();
    }

    #[test]
    fn a_hidden_window_drains_without_decoding_or_sending() {
        let rig = start(Knobs::default(), true);
        rig.knobs.loud.store(true, Ordering::SeqCst);
        settle(150);
        rig.paused.store(true, Ordering::SeqCst);
        settle(60);
        let sent = count(&rig);
        let discards = rig.knobs.discards.load(Ordering::SeqCst);
        settle(200);
        assert_eq!(count(&rig), sent, "frames were sent while hidden");
        assert!(
            rig.knobs.discards.load(Ordering::SeqCst) > discards,
            "audio was not released while hidden"
        );

        rig.paused.store(false, Ordering::SeqCst);
        settle(300);
        assert!(count(&rig) > sent, "frames did not resume");
        rig.capture.stop();
    }

    #[test]
    fn a_device_that_goes_away_is_followed_without_ending_the_session() {
        let knobs = Knobs::default();
        knobs.reopen_works.store(true, Ordering::SeqCst);
        let rig = start(knobs, true);
        rig.knobs.loud.store(true, Ordering::SeqCst);
        settle(150);
        rig.knobs.gone.store(true, Ordering::SeqCst);
        settle(150);
        assert_eq!(rig.knobs.reopens.load(Ordering::SeqCst), 1);
        let before = count(&rig);
        settle(200);
        assert!(count(&rig) > before, "no frames from the new device");
        assert!(rig.ended.try_recv().is_err());
        rig.capture.stop();
    }

    #[test]
    fn a_device_that_does_not_come_back_is_lost() {
        let rig = start(Knobs::default(), true);
        rig.knobs.gone.store(true, Ordering::SeqCst);
        assert_eq!(exit_of(&rig), Some(Exit::Lost));
    }

    #[test]
    fn stopping_while_a_device_is_being_reopened_is_a_stop_not_a_loss() {
        let rig = start(Knobs::default(), true);
        rig.capture.stop();
        rig.knobs.gone.store(true, Ordering::SeqCst);
        assert_eq!(exit_of(&rig), Some(Exit::Stopped));
    }

    #[test]
    fn lock_or_suspend_ends_the_session() {
        let rig = start(Knobs::default(), true);
        rig.knobs.loud.store(true, Ordering::SeqCst);
        settle(50);
        rig.knobs.locked.store(true, Ordering::SeqCst);
        assert_eq!(exit_of(&rig), Some(Exit::Lost));
    }

    #[test]
    fn an_unrecoverable_device_error_is_a_loss() {
        let rig = start(Knobs::default(), true);
        rig.knobs.fail.store(true, Ordering::SeqCst);
        assert_eq!(exit_of(&rig), Some(Exit::Lost));
    }

    #[test]
    fn the_page_going_away_ends_capture_as_a_stop() {
        let rig = start(Knobs::default(), false); // on_frame returns false
        rig.knobs.loud.store(true, Ordering::SeqCst);
        assert_eq!(exit_of(&rig), Some(Exit::Stopped));
        assert_eq!(count(&rig), 1, "nothing is sent after the listener is gone");
    }

    #[test]
    fn a_panic_on_the_capture_thread_still_reports_the_end() {
        let rig = start(Knobs::default(), true);
        rig.knobs.panic.store(true, Ordering::SeqCst);
        assert_eq!(exit_of(&rig), Some(Exit::Lost));
    }

    #[test]
    fn a_setup_failure_is_returned_to_the_caller() {
        let result = spawn::<Fake>(
            Options::new(Duration::from_millis(10), Arc::new(AtomicBool::new(false))),
            || Err("No audio output device is available".to_string()),
            |_| true,
            |_| {},
        );
        assert_eq!(
            result.err().as_deref(),
            Some("No audio output device is available")
        );
    }
}
