//! Windows system-audio capture: WASAPI shared-mode loopback on the default output device.
//!
//! This file is only the device. *When* to work (silence, hidden window, pacing) lives in `engine.rs`.
//!
//! - A loopback stream delivers no packets while nothing is playing, which is what lets the engine idle.
//! - No event handles, no MMCSS, and no `timeBeginPeriod`: raising the global timer resolution would cost every
//!   process on the machine power.
//! - Capture stops on session lock (read from the session's own state, no window or message pump needed) and on
//!   suspend (a power-notification callback).

use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{HANDLE, WIN32_ERROR},
        Media::Audio::{
            eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDevice, IMMDeviceEnumerator,
            MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED,
            AUDCLNT_E_RESOURCES_INVALIDATED, AUDCLNT_E_SERVICE_NOT_RUNNING,
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX,
            WAVEFORMATEXTENSIBLE,
        },
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
                COINIT_MULTITHREADED,
            },
            Power::{
                PowerRegisterSuspendResumeNotification, PowerUnregisterSuspendResumeNotification,
                DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS, HPOWERNOTIFY,
            },
            RemoteDesktop::{
                WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
                WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION, WTS_SESSIONSTATE_LOCK,
            },
        },
        UI::WindowsAndMessaging::DEVICE_NOTIFY_CALLBACK,
    },
};

use super::analyzer::{Analyzer, Frame};
use super::channels::StereoMix;
use super::engine::{spawn, Device, Fault, Session};
pub use super::engine::{Capture, Exit, Options};

/// 200 ms of engine buffer: ample for a 30 fps drain, small enough not to hold stale audio.
const BUFFER_100NS: i64 = 2_000_000;
const REOPEN_TRIES: u32 = 6;
const REOPEN_WAIT: Duration = Duration::from_millis(500);
const DEFAULT_OUTPUT_EVERY: Duration = Duration::from_millis(500);

const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
const PBT_APMSUSPEND: u32 = 4;

/// Whether this device can hear its own output at all. Cheap and side-effect free.
pub fn supported() -> bool {
    true
}

/// Open the default output device and start analysing it on a dedicated thread. See `engine::spawn`.
pub fn start(
    options: Options,
    on_frame: impl FnMut(&Frame) -> bool + Send + 'static,
    on_end: impl FnOnce(Exit) + Send + 'static,
) -> Result<Capture, String> {
    let stereo = options.stereo;
    spawn(
        options,
        move || {
            let com = Com::init();
            let guard = Interrupts::register()?;
            let device =
                unsafe { Stream::open(stereo) }.map_err(|error| describe_open_error(&error))?;
            Ok(Session {
                device,
                reopen: Box::new(move |stop| reopen(stop, stereo)),
                interrupted: Box::new(move || guard.tripped() || session_locked()),
                keep: Box::new(com),
            })
        },
        on_frame,
        on_end,
    )
}

fn describe_open_error(error: &windows::core::Error) -> String {
    // E_NOTFOUND is what "no output device" looks like.
    if error.code().0 == 0x8007_0490u32 as i32 {
        "No audio output device is available".into()
    } else {
        format!("Could not open the audio output device ({})", error.code())
    }
}

struct Com;

impl Com {
    fn init() -> Self {
        // S_FALSE (already initialised) is fine; a failure here surfaces when the first COM call fails.
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        Com
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

#[derive(Clone, Copy)]
enum Sample {
    F32,
    I16,
    I32,
}

struct Stream {
    enumerator: IMMDeviceEnumerator,
    default_output: DefaultOutput,
    client: IAudioClient,
    capture: IAudioCaptureClient,
    channels: usize,
    sample_rate: u32,
    sample: Sample,
    /// Reused for every packet, so a drain allocates nothing once warm.
    scratch: Vec<f32>,
    stereo_mix: Option<StereoMix>,
}

struct DefaultOutput {
    id: Vec<u16>,
    next_check: Instant,
}

impl DefaultOutput {
    fn changed(
        &mut self,
        now: Instant,
        resolve: impl FnOnce() -> windows::core::Result<Vec<u16>>,
    ) -> windows::core::Result<bool> {
        if now < self.next_check {
            return Ok(false);
        }
        self.next_check = now + DEFAULT_OUTPUT_EVERY;
        Ok(resolve()? != self.id)
    }
}

unsafe fn endpoint_id(device: &IMMDevice) -> windows::core::Result<Vec<u16>> {
    let id = device.GetId()?;
    let value = id.as_wide().to_vec();
    CoTaskMemFree(Some(id.0 as *const c_void));
    Ok(value)
}

impl Drop for Stream {
    fn drop(&mut self) {
        unsafe {
            let _ = self.client.Stop();
        }
    }
}

impl Stream {
    unsafe fn open(stereo: bool) -> windows::core::Result<Stream> {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
        let default_output = DefaultOutput {
            id: endpoint_id(&device)?,
            next_check: Instant::now(),
        };
        let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;

        let format = client.GetMixFormat()?;
        let described = describe_format(format)
            .filter(|(channels, _, _, mask)| !stereo || StereoMix::new(*channels, *mask).is_some());
        let initialised = match described {
            Some(_) => client.Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK,
                BUFFER_100NS,
                0,
                format,
                None,
            ),
            None => Err(windows::core::Error::from(
                windows::Win32::Foundation::E_NOTIMPL,
            )),
        };
        CoTaskMemFree(Some(format as *const c_void));
        initialised?;
        let (channels, sample_rate, sample, mask) = described.unwrap();

        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        Ok(Stream {
            enumerator,
            default_output,
            client,
            capture,
            channels,
            sample_rate,
            sample,
            scratch: Vec::new(),
            stereo_mix: if stereo {
                StereoMix::new(channels, mask)
            } else {
                None
            },
        })
    }

    fn width(&self) -> usize {
        match self.sample {
            Sample::I16 => 2,
            Sample::F32 | Sample::I32 => 4,
        }
    }

    /// Append `bytes` to the scratch buffer as floats (non-finite values become silence). Returns the loudest
    /// absolute sample.
    fn decode(&mut self, bytes: &[u8]) -> f32 {
        let mut loudest = 0.0f32;
        let out = &mut self.scratch;
        let mut push = |value: f32| {
            let value = if value.is_finite() { value } else { 0.0 };
            loudest = loudest.max(value.abs());
            out.push(value);
        };
        match self.sample {
            Sample::F32 => bytes
                .chunks_exact(4)
                .for_each(|b| push(f32::from_le_bytes([b[0], b[1], b[2], b[3]]))),
            Sample::I16 => bytes
                .chunks_exact(2)
                .for_each(|b| push(i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0)),
            Sample::I32 => bytes.chunks_exact(4).for_each(|b| {
                push(i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32 / 2_147_483_648.0)
            }),
        }
        loudest
    }

    unsafe fn drain_packets(
        &mut self,
        analyzer: &mut Analyzer,
        discard: bool,
    ) -> windows::core::Result<f32> {
        let mut loudest = 0.0f32;
        while self.capture.GetNextPacketSize()? > 0 {
            let (mut data, mut frames, mut flags) = (std::ptr::null_mut::<u8>(), 0u32, 0u32);
            self.capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            if !discard {
                let count = frames as usize * self.channels;
                self.scratch.clear();
                if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null() {
                    self.scratch.resize(count, 0.0);
                } else {
                    let bytes = std::slice::from_raw_parts(data, count * self.width());
                    loudest = loudest.max(self.decode(bytes));
                }
                if let Some(mix) = &self.stereo_mix {
                    analyzer.push_mapped(&self.scratch, mix);
                } else {
                    analyzer.push(&self.scratch, self.channels);
                }
            }
            self.capture.ReleaseBuffer(frames)?;
        }
        Ok(loudest)
    }
}

impl Device for Stream {
    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn drain(&mut self, analyzer: &mut Analyzer, discard: bool) -> Result<f32, Fault> {
        // Changing the default does not invalidate a still-connected old endpoint. Check its identity even while
        // silent or hidden, at a bounded rate, and let the shared engine reopen the stream when it changes.
        let enumerator = &self.enumerator;
        match self.default_output.changed(Instant::now(), || unsafe {
            endpoint_id(&enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?)
        }) {
            Ok(false) => {}
            Ok(true) | Err(_) => return Err(Fault::Gone),
        }
        unsafe { self.drain_packets(analyzer, discard) }.map_err(|error| {
            if device_gone(&error) {
                Fault::Gone
            } else {
                Fault::Failed
            }
        })
    }
}

/// Channels, rate and sample type of a mix format, or None for one this adapter does not read.
unsafe fn describe_format(format: *const WAVEFORMATEX) -> Option<(usize, u32, Sample, u32)> {
    if format.is_null() {
        return None;
    }
    // The structs are packed: copy them out instead of taking references to their fields.
    let base = std::ptr::read_unaligned(format);
    let (tag, bits) = (base.wFormatTag, base.wBitsPerSample);
    let (tag, mask) = if tag == WAVE_FORMAT_EXTENSIBLE {
        if base.cbSize < 22 {
            return None;
        }
        let extended = std::ptr::read_unaligned(format as *const WAVEFORMATEXTENSIBLE);
        let guid = extended.SubFormat;
        if guid.data2 != 0
            || guid.data3 != 0x10
            || guid.data4 != [0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
            || guid.data1 > u16::MAX as u32
        {
            return None;
        }
        (guid.data1 as u16, extended.dwChannelMask)
    } else {
        (tag, 0)
    };
    let sample = match (tag, bits) {
        (WAVE_FORMAT_IEEE_FLOAT, 32) => Sample::F32,
        (WAVE_FORMAT_PCM, 16) => Sample::I16,
        (WAVE_FORMAT_PCM, 32) => Sample::I32,
        _ => return None,
    };
    let (channels, rate) = (base.nChannels as usize, base.nSamplesPerSec);
    (channels > 0 && channels <= 32 && rate >= 8_000).then_some((channels, rate, sample, mask))
}

fn device_gone(error: &windows::core::Error) -> bool {
    [
        AUDCLNT_E_DEVICE_INVALIDATED,
        AUDCLNT_E_RESOURCES_INVALIDATED,
        AUDCLNT_E_SERVICE_NOT_RUNNING,
    ]
    .contains(&error.code())
}

fn reopen(stop: &AtomicBool, stereo: bool) -> Option<Stream> {
    for _ in 0..REOPEN_TRIES {
        thread::sleep(REOPEN_WAIT);
        if stop.load(Ordering::Relaxed) {
            return None;
        }
        if let Ok(stream) = unsafe { Stream::open(stereo) } {
            return Some(stream);
        }
    }
    None
}

/// True while the interactive session is locked. Windows reports lock as session flag 0 and unlock as 1.
fn session_locked() -> bool {
    unsafe {
        let (mut buffer, mut length) = (PWSTR::null(), 0u32);
        if WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            WTS_CURRENT_SESSION,
            WTSSessionInfoEx,
            &mut buffer,
            &mut length,
        )
        .is_err()
        {
            return false;
        }
        let locked = !buffer.is_null() && length as usize >= std::mem::size_of::<WTSINFOEXW>() && {
            let info = &*(buffer.0 as *const WTSINFOEXW);
            info.Level == 1
                && info.Data.WTSInfoExLevel1.SessionFlags == WTS_SESSIONSTATE_LOCK as i32
        };
        WTSFreeMemory(buffer.0 as *mut c_void);
        locked
    }
}

/// Learns about suspend without a window or a message pump.
struct Interrupts {
    suspended: Arc<AtomicBool>,
    handle: *mut c_void,
    context: *const AtomicBool,
    _params: Box<DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS>,
}

unsafe extern "system" fn on_power(
    context: *const c_void,
    kind: u32,
    _setting: *const c_void,
) -> u32 {
    if kind == PBT_APMSUSPEND && !context.is_null() {
        (*(context as *const AtomicBool)).store(true, Ordering::SeqCst);
    }
    0
}

impl Interrupts {
    fn register() -> Result<Self, String> {
        let suspended = Arc::new(AtomicBool::new(false));
        let context = Arc::into_raw(suspended.clone());
        let params = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
            Callback: Some(on_power),
            Context: context as *mut c_void,
        });
        let mut handle: *mut c_void = std::ptr::null_mut();
        let status = unsafe {
            PowerRegisterSuspendResumeNotification(
                DEVICE_NOTIFY_CALLBACK,
                HANDLE(&*params as *const _ as *mut c_void),
                &mut handle,
            )
        };
        if status != WIN32_ERROR(0) || handle.is_null() {
            unsafe { drop(Arc::from_raw(context)) };
            return Err("Could not watch for system sleep, so system audio was not started".into());
        }
        Ok(Self {
            suspended,
            handle,
            context,
            _params: params,
        })
    }

    fn tripped(&self) -> bool {
        self.suspended.load(Ordering::SeqCst)
    }
}

impl Drop for Interrupts {
    fn drop(&mut self) {
        unsafe {
            let _ = PowerUnregisterSuspendResumeNotification(HPOWERNOTIFY(self.handle as isize));
            drop(Arc::from_raw(self.context));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::atomic::AtomicUsize, time::Instant};

    #[test]
    fn default_output_switch_is_detected_without_invalidating_the_old_endpoint() {
        let now = Instant::now();
        let mut output = DefaultOutput {
            id: vec![1, 2],
            next_check: now,
        };
        assert!(!output.changed(now, || Ok(vec![1, 2])).unwrap());
        assert!(!output
            .changed(now + Duration::from_millis(100), || panic!(
                "queried too often"
            ))
            .unwrap());
        assert!(output
            .changed(now + DEFAULT_OUTPUT_EVERY, || Ok(vec![3, 4]))
            .unwrap());
    }

    #[test]
    fn loss_of_the_default_output_triggers_recovery() {
        let now = Instant::now();
        let mut output = DefaultOutput {
            id: vec![1],
            next_check: now,
        };
        assert!(output
            .changed(now, || Err(windows::core::Error::from(
                windows::Win32::Foundation::E_FAIL
            )))
            .is_err());
    }

    #[test]
    fn mix_format_decoding_rejects_what_it_cannot_read() {
        let mut format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
            nChannels: 2,
            nSamplesPerSec: 48_000,
            wBitsPerSample: 32,
            ..Default::default()
        };
        assert!(matches!(
            unsafe { describe_format(&format) },
            Some((2, 48_000, Sample::F32, 0))
        ));
        format.wBitsPerSample = 24; // packed 24-bit PCM is not read
        format.wFormatTag = WAVE_FORMAT_PCM;
        assert!(unsafe { describe_format(&format) }.is_none());
        format.wBitsPerSample = 16;
        assert!(matches!(
            unsafe { describe_format(&format) },
            Some((2, 48_000, Sample::I16, 0))
        ));
        format.nChannels = 0;
        assert!(unsafe { describe_format(&format) }.is_none());
        assert!(unsafe { describe_format(std::ptr::null()) }.is_none());
    }

    #[test]
    fn extensible_mix_formats_retain_speaker_positions_and_validate_the_full_subformat() {
        let mut format = WAVEFORMATEXTENSIBLE {
            Format: WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_EXTENSIBLE,
                nChannels: 6,
                nSamplesPerSec: 48_000,
                wBitsPerSample: 32,
                cbSize: 22,
                ..Default::default()
            },
            dwChannelMask: 0x60f,
            SubFormat: windows::core::GUID::from_values(
                3,
                0,
                0x10,
                [0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71],
            ),
            ..Default::default()
        };
        let pointer =
            |format: &WAVEFORMATEXTENSIBLE| (format as *const WAVEFORMATEXTENSIBLE).cast();
        assert!(matches!(
            unsafe { describe_format(pointer(&format)) },
            Some((6, 48_000, Sample::F32, 0x60f))
        ));
        format.SubFormat.data4[7] = 0;
        assert!(unsafe { describe_format(pointer(&format)) }.is_none());
        format.Format.cbSize = 0;
        assert!(unsafe { describe_format(pointer(&format)) }.is_none());
    }

    #[test]
    fn the_session_lock_query_works_on_this_machine() {
        // The test runs in an unlocked interactive session.
        assert!(!session_locked());
    }

    /// Needs a real output device and something playing. Run while audio plays:
    /// `cargo test --lib live_loopback -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a real output device"]
    fn live_loopback() {
        let seconds: u64 = std::env::var("LIVE_SECONDS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(12);
        let frames = Arc::new(AtomicUsize::new(0));
        let counter = frames.clone();
        let started = Instant::now();
        let capture = start(
            Options::new(Duration::from_millis(33), Arc::new(AtomicBool::new(false))),
            move |frame| {
                let n = counter.fetch_add(1, Ordering::Relaxed);
                if n % 10 == 0 || frame.amplitude == 0.0 {
                    let top = (0..64)
                        .max_by(|&a, &b| frame.bands[a].total_cmp(&frame.bands[b]))
                        .unwrap();
                    println!(
                        "{:>6.2}s frame {n:>4} amp {:.2} peak {:.2} loudest band {top:>2} ({:.2})",
                        started.elapsed().as_secs_f32(),
                        frame.amplitude,
                        frame.peak,
                        frame.bands[top]
                    );
                }
                true
            },
            |exit| println!("ended: {exit:?}"),
        )
        .expect("the default output device should open");
        println!("capturing for {seconds}s");
        thread::sleep(Duration::from_secs(seconds));
        capture.stop();
        thread::sleep(Duration::from_millis(600));
        println!("total frames: {}", frames.load(Ordering::Relaxed));
    }
}
