//! A [`Device`] fed by a child process that writes raw `f32` stereo PCM to a pipe (Linux: `parec` on the default
//! output's monitor). Everything that is not "start the process" lives here, so it is tested on every OS with a fake
//! child.
//!
//! - A small reader thread does the blocking `read` and hands whole chunks over a channel; the engine's thread only
//!   ever polls that channel, so the engine can notice a stop, a lock or a hidden window while the pipe is silent.
//! - **A hidden window kills the child**, and the next drain starts it again, so nothing runs and nothing wakes.
//! - After a long quiet spell the child is restarted, which is how a change of default output device is followed
//!   (a monitor stream stays on the device it started with).
//! - A child that exits (the sound server restarted, the device vanished) surfaces as [`Fault::Gone`], and the
//!   engine's reopen logic takes it from there.

use std::{
    io::{self, Read},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError, TryRecvError},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use super::{
    analyzer::Analyzer,
    engine::{Device, Fault},
};

pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
const BYTES_PER_FRAME: usize = CHANNELS * 4;
/// Quiet this long and the child is restarted, so the default output is looked up again.
const RESOLVE_EVERY: Duration = Duration::from_secs(10);
/// A child that is going to fail (no sound server, no such device) does so almost at once.
const HEALTH_CHECK: Duration = Duration::from_millis(250);
/// About -80 dBFS, the same threshold the engine uses.
const AUDIBLE: f32 = 1e-4;

/// A started child: where its audio comes from, and how to end it. `end` must make a blocked `read` return.
pub struct Running {
    pub reader: Box<dyn Read + Send>,
    pub end: Box<dyn FnMut() + Send>,
}

pub type Opener = Arc<dyn Fn() -> io::Result<Running> + Send + Sync>;

struct Live {
    chunks: Receiver<Vec<u8>>,
    end: Box<dyn FnMut() + Send>,
    /// A chunk that arrived during the health check, processed first.
    pending: Option<Vec<u8>>,
}

pub struct PipeDevice {
    open: Opener,
    chunk_bytes: usize,
    live: Option<Live>,
    quiet_since: Instant,
    scratch: Vec<f32>,
}

impl PipeDevice {
    /// `interval` is the frame interval: the reader hands over one chunk per interval, so it wakes no more often than
    /// the engine does.
    pub fn new(open: Opener, interval: Duration) -> Self {
        let frames = ((SAMPLE_RATE as f64 * interval.as_secs_f64()) as usize)
            .clamp(256, SAMPLE_RATE as usize);
        Self {
            open,
            chunk_bytes: frames * BYTES_PER_FRAME,
            live: None,
            quiet_since: Instant::now(),
            scratch: Vec::new(),
        }
    }

    /// Start the child and make sure it stays up past its first moments.
    pub fn connect(&mut self) -> io::Result<()> {
        self.close();
        let Running {
            mut reader,
            mut end,
        } = (self.open)()?;
        let (tx, chunks) = mpsc::sync_channel::<Vec<u8>>(16);
        let size = self.chunk_bytes;
        thread::Builder::new()
            .name("lumiverse-system-audio-pipe".into())
            .spawn(move || loop {
                let mut chunk = vec![0u8; size];
                if reader.read_exact(&mut chunk).is_err() || tx.send(chunk).is_err() {
                    break;
                }
            })?;
        // `sync_channel` has no `recv_timeout` on the sending half, so health-check on the receiving one.
        let first = match chunks.recv_timeout(HEALTH_CHECK) {
            Ok(chunk) => Some(chunk),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => {
                end();
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "the audio source exited immediately",
                ));
            }
        };
        self.live = Some(Live {
            chunks,
            end,
            pending: first,
        });
        self.quiet_since = Instant::now();
        Ok(())
    }

    fn close(&mut self) {
        if let Some(mut live) = self.live.take() {
            (live.end)();
        }
    }

    fn consume(&mut self, analyzer: &mut Analyzer, bytes: &[u8]) -> f32 {
        let mut loudest = 0.0f32;
        self.scratch.clear();
        self.scratch.extend(bytes.chunks_exact(4).map(|b| {
            let value = f32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            let value = if value.is_finite() { value } else { 0.0 };
            loudest = loudest.max(value.abs());
            value
        }));
        analyzer.push(&self.scratch, CHANNELS);
        loudest
    }
}

impl Drop for PipeDevice {
    fn drop(&mut self) {
        self.close();
    }
}

impl Device for PipeDevice {
    fn sample_rate(&self) -> u32 {
        SAMPLE_RATE
    }

    fn drain(&mut self, analyzer: &mut Analyzer, discard: bool) -> Result<f32, Fault> {
        if discard {
            // Hidden: nothing should run at all.
            self.close();
            return Ok(0.0);
        }
        if self.live.is_none() {
            self.connect().map_err(|_| Fault::Gone)?;
        }
        let mut loudest = 0.0f32;
        let mut gone = false;
        // Take the chunks out first so `consume` can borrow `self`.
        let mut ready: Vec<Vec<u8>> = Vec::new();
        if let Some(live) = self.live.as_mut() {
            ready.extend(live.pending.take());
            loop {
                match live.chunks.try_recv() {
                    Ok(chunk) => ready.push(chunk),
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        gone = true;
                        break;
                    }
                }
            }
        }
        for chunk in &ready {
            loudest = loudest.max(self.consume(analyzer, chunk));
        }
        if gone {
            self.close();
            return Err(Fault::Gone);
        }
        let now = Instant::now();
        if loudest > AUDIBLE {
            self.quiet_since = now;
        } else if now.duration_since(self.quiet_since) > RESOLVE_EVERY {
            self.close();
        }
        Ok(loudest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Mutex,
    };

    /// A "child" whose pipe yields a fixed stream, can be made silent, and ends when told to.
    #[derive(Clone, Default)]
    struct Fake {
        starts: Arc<AtomicUsize>,
        ends: Arc<AtomicUsize>,
        loud: Arc<AtomicBool>,
        dies_at_once: Arc<AtomicBool>,
        dies_later: Arc<AtomicBool>,
        refuses: Arc<AtomicBool>,
        ended: Arc<Mutex<Vec<Arc<AtomicBool>>>>,
    }

    struct Pipe {
        loud: Arc<AtomicBool>,
        dies_at_once: bool,
        dies_later: Arc<AtomicBool>,
        ended: Arc<AtomicBool>,
        phase: f32,
    }

    impl Read for Pipe {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.dies_at_once
                || self.ended.load(Ordering::SeqCst)
                || self.dies_later.load(Ordering::SeqCst)
            {
                return Ok(0);
            }
            thread::sleep(Duration::from_millis(2));
            for pair in out.chunks_exact_mut(8) {
                self.phase += 2.0 * std::f32::consts::PI * 440.0 / SAMPLE_RATE as f32;
                let v = if self.loud.load(Ordering::SeqCst) {
                    0.3 * self.phase.sin()
                } else {
                    0.0
                };
                pair[..4].copy_from_slice(&v.to_le_bytes());
                pair[4..].copy_from_slice(&v.to_le_bytes());
            }
            Ok(out.len() / 8 * 8)
        }
    }

    impl Fake {
        fn opener(&self) -> Opener {
            let me = self.clone();
            Arc::new(move || {
                me.starts.fetch_add(1, Ordering::SeqCst);
                if me.refuses.load(Ordering::SeqCst) {
                    return Err(io::Error::new(io::ErrorKind::NotFound, "no parec"));
                }
                let ended = Arc::new(AtomicBool::new(false));
                me.ended.lock().unwrap().push(ended.clone());
                let (flag, count) = (ended.clone(), me.ends.clone());
                Ok(Running {
                    reader: Box::new(Pipe {
                        loud: me.loud.clone(),
                        dies_at_once: me.dies_at_once.load(Ordering::SeqCst),
                        dies_later: me.dies_later.clone(),
                        ended,
                        phase: 0.0,
                    }),
                    end: Box::new(move || {
                        flag.store(true, Ordering::SeqCst);
                        count.fetch_add(1, Ordering::SeqCst);
                    }),
                })
            })
        }
    }

    fn device(fake: &Fake) -> (PipeDevice, Analyzer) {
        (
            PipeDevice::new(fake.opener(), Duration::from_millis(20)),
            Analyzer::new(SAMPLE_RATE),
        )
    }

    fn drain_for(device: &mut PipeDevice, analyzer: &mut Analyzer, ms: u64) -> f32 {
        let until = Instant::now() + Duration::from_millis(ms);
        let mut loudest = 0.0f32;
        while Instant::now() < until {
            loudest = loudest.max(device.drain(analyzer, false).unwrap());
            thread::sleep(Duration::from_millis(5));
        }
        loudest
    }

    #[test]
    fn audio_from_the_pipe_reaches_the_analyzer() {
        let fake = Fake::default();
        fake.loud.store(true, Ordering::SeqCst);
        let (mut device, mut analyzer) = device(&fake);
        let loudest = drain_for(&mut device, &mut analyzer, 200);
        assert!(loudest > 0.2, "{loudest}");
        let mut frame = super::super::analyzer::Frame::default();
        assert!(analyzer.analyse(&mut frame));
        assert!(frame.bands.iter().any(|&b| b > 0.3));
    }

    #[test]
    fn silence_is_reported_as_silence() {
        let fake = Fake::default();
        let (mut device, mut analyzer) = device(&fake);
        assert_eq!(drain_for(&mut device, &mut analyzer, 100), 0.0);
    }

    #[test]
    fn pipe_preserves_separate_sides_and_sanitises_non_finite_samples() {
        let fake = Fake::default();
        let mut device = PipeDevice::new(fake.opener(), Duration::from_millis(20));
        let bytes: Vec<u8> = (0..4096)
            .flat_map(|i| {
                let l = 0.02
                    * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SAMPLE_RATE as f32).sin();
                [l, f32::NAN].into_iter().flat_map(|v| v.to_le_bytes())
            })
            .collect();
        let mut analyzer = Analyzer::with_stereo(SAMPLE_RATE, true);
        assert!(device.consume(&mut analyzer, &bytes) > 0.0);
        let mut frame = super::super::analyzer::Frame::default();
        assert!(analyzer.analyse(&mut frame));
        let stereo = frame.stereo.unwrap();
        assert!(stereo.left.amplitude > 0.0);
        assert_eq!(stereo.right.amplitude, 0.0);
        assert!(stereo.right.bands.iter().all(|&b| b == 0.0));
    }

    #[test]
    fn a_hidden_window_ends_the_child_and_showing_it_again_starts_a_new_one() {
        let fake = Fake::default();
        fake.loud.store(true, Ordering::SeqCst);
        let (mut device, mut analyzer) = device(&fake);
        drain_for(&mut device, &mut analyzer, 60);
        assert_eq!(fake.starts.load(Ordering::SeqCst), 1);

        assert_eq!(device.drain(&mut analyzer, true), Ok(0.0));
        assert_eq!(
            fake.ends.load(Ordering::SeqCst),
            1,
            "the child was left running while hidden"
        );
        // Hidden drains stay hidden: no restart.
        device.drain(&mut analyzer, true).unwrap();
        assert_eq!(fake.starts.load(Ordering::SeqCst), 1);

        let loudest = drain_for(&mut device, &mut analyzer, 100);
        assert_eq!(fake.starts.load(Ordering::SeqCst), 2);
        assert!(loudest > 0.2);
    }

    #[test]
    fn a_child_that_dies_at_once_is_an_error_not_a_session() {
        let fake = Fake::default();
        fake.dies_at_once.store(true, Ordering::SeqCst);
        let (mut device, _) = device(&fake);
        assert!(device.connect().is_err());
        assert_eq!(
            fake.ends.load(Ordering::SeqCst),
            1,
            "a dead child must still be reaped"
        );
    }

    #[test]
    fn a_missing_program_is_an_error() {
        let fake = Fake::default();
        fake.refuses.store(true, Ordering::SeqCst);
        let (mut device, mut analyzer) = device(&fake);
        assert!(device.connect().is_err());
        assert_eq!(device.drain(&mut analyzer, false), Err(Fault::Gone));
    }

    #[test]
    fn a_child_that_exits_later_is_a_device_that_went_away() {
        let fake = Fake::default();
        fake.loud.store(true, Ordering::SeqCst);
        let (mut device, mut analyzer) = device(&fake);
        drain_for(&mut device, &mut analyzer, 60);
        fake.dies_later.store(true, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(80));
        let mut result = Ok(0.0);
        for _ in 0..40 {
            result = device.drain(&mut analyzer, false);
            if result.is_err() {
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(result, Err(Fault::Gone));
        assert_eq!(
            fake.ends.load(Ordering::SeqCst),
            1,
            "the exited child is cleaned up"
        );
    }

    #[test]
    fn dropping_the_device_ends_the_child() {
        let fake = Fake::default();
        {
            let (mut device, mut analyzer) = device(&fake);
            device.drain(&mut analyzer, false).unwrap();
        }
        assert_eq!(fake.ends.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_default_output_is_looked_up_again_after_a_long_quiet_spell() {
        let fake = Fake::default();
        let (mut device, mut analyzer) = device(&fake);
        device.drain(&mut analyzer, false).unwrap();
        device.quiet_since = Instant::now() - RESOLVE_EVERY - Duration::from_secs(1);
        device.drain(&mut analyzer, false).unwrap(); // notices, closes
        assert_eq!(fake.ends.load(Ordering::SeqCst), 1);
        device.drain(&mut analyzer, false).unwrap(); // reconnects
        assert_eq!(fake.starts.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn the_chunk_size_follows_the_frame_interval() {
        let fake = Fake::default();
        let thirty = PipeDevice::new(fake.opener(), Duration::from_millis(33));
        assert_eq!(thirty.chunk_bytes, 1584 * BYTES_PER_FRAME);
        let silly = PipeDevice::new(fake.opener(), Duration::from_millis(0));
        assert_eq!(silly.chunk_bytes, 256 * BYTES_PER_FRAME);
    }
}

// ─── Linux helpers kept here so they are tested on every OS ──────────────────────────────────────────────────────

/// Arguments for `parec`. The device is the **monitor of the default output**, spelled out: without `--device`
/// `parec` records from the default *source*, which is the microphone. A test pins this.
pub fn parec_args(interval: Duration) -> Vec<String> {
    let latency = (interval.as_millis() as u64).clamp(10, 100);
    [
        "--device=@DEFAULT_MONITOR@",
        "--format=float32le",
        "--rate=48000",
        "--channels=2",
        "--channel-map=front-left,front-right",
        "--raw",
        "--client-name=Lumiverse",
        "--stream-name=Lumiverse extension audio analysis",
    ]
    .into_iter()
    .map(String::from)
    .chain(std::iter::once(format!("--latency-msec={latency}")))
    .collect()
}

/// Seconds since boot including time spent suspended, from `/proc/uptime`.
pub fn parse_uptime(text: &str) -> Option<f64> {
    text.split_whitespace()
        .next()?
        .parse::<f64>()
        .ok()
        .filter(|up| up.is_finite() && *up >= 0.0)
}

/// `Instant` stops during suspend and uptime does not, so uptime pulling ahead of it means the machine slept.
pub fn slept(uptime_before: f64, uptime_now: f64, monotonic_elapsed: Duration) -> bool {
    (uptime_now - uptime_before) - monotonic_elapsed.as_secs_f64() > 2.0
}

/// Session ids are short alphanumerics; refuse anything else before it reaches a command line.
pub fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 32 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

#[cfg(test)]
mod helper_tests {
    use super::*;

    #[test]
    fn parec_records_the_default_outputs_monitor_never_the_microphone() {
        for interval in [0u64, 10, 33, 500] {
            let args = parec_args(Duration::from_millis(interval));
            assert!(
                args.contains(&"--device=@DEFAULT_MONITOR@".to_string()),
                "{args:?}"
            );
            // The only device-selecting arguments allowed are that one.
            assert_eq!(
                args.iter()
                    .filter(|a| a.starts_with("--device") || a.starts_with("-d"))
                    .count(),
                1
            );
            assert!(args
                .iter()
                .all(|a| !a.contains("DEFAULT_SOURCE") && !a.contains("input")));
            assert!(
                args.contains(&"--format=float32le".to_string())
                    && args.contains(&"--raw".to_string())
            );
            assert!(args.contains(&"--channel-map=front-left,front-right".to_string()));
        }
    }

    #[test]
    fn latency_follows_the_frame_interval_within_sane_bounds() {
        let latency = |ms| {
            parec_args(Duration::from_millis(ms))
                .last()
                .cloned()
                .unwrap()
        };
        assert_eq!(latency(0), "--latency-msec=10");
        assert_eq!(latency(33), "--latency-msec=33");
        assert_eq!(latency(1000), "--latency-msec=100");
    }

    #[test]
    fn uptime_parsing_is_strict() {
        assert_eq!(parse_uptime("12345.67 54321.00\n"), Some(12345.67));
        for bad in ["", "abc", "-1 2", "inf 3", "NaN 1"] {
            assert_eq!(parse_uptime(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_suspend_is_uptime_running_ahead_of_the_monotonic_clock() {
        // Ordinary pacing: both clocks moved by about the same.
        assert!(!slept(100.0, 100.5, Duration::from_millis(500)));
        // Under the two-second margin is jitter, not sleep.
        assert!(!slept(100.0, 101.9, Duration::from_millis(500)));
        // Asleep for ten minutes: uptime moved, the monotonic clock did not.
        assert!(slept(100.0, 700.5, Duration::from_millis(500)));
        // A slow tick is not a sleep.
        assert!(!slept(100.0, 101.5, Duration::from_millis(1400)));
    }

    #[test]
    fn session_ids_are_checked_before_they_reach_a_command_line() {
        assert!(valid_session_id("2"));
        assert!(valid_session_id("c12"));
        for bad in ["", "-p", "a b", "1;rm", "../x", &"9".repeat(33)] {
            assert!(!valid_session_id(bad), "{bad:?}");
        }
    }
}
