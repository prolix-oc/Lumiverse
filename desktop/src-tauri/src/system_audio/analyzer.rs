//! Spectrum analysis for `ctx.systemAudio`.
//!
//! Samples are reduced to levels and log-spaced bands right here, on the capture thread. Nothing but the result
//! leaves this module, so there is no audio for anything downstream to leak.
//!
//! Cost: one FFT per *emitted* frame (not per packet) over a ring buffer of the latest samples, with every table and
//! scratch buffer allocated once. Optional stereo adds two FFTs and two rings only when requested.

use std::f32::consts::PI;

/// Bands delivered per frame. The frontend rebins to whatever the extension asked for (8 – 64).
pub const BANDS: usize = 64;
const LOWEST_HZ: f32 = 40.0;
const HIGHEST_HZ: f32 = 14_000.0;
/// Same decibel window as a browser `AnalyserNode` (-100 … -30 dB), so system audio and in-app audio look alike.
const FLOOR_DB: f32 = -100.0;
const CEIL_DB: f32 = -30.0;
/// Level meters span -60 … 0 dBFS.
const LEVEL_FLOOR_DB: f32 = -60.0;
/// How much of the previous peak survives each frame.
const PEAK_DECAY: f32 = 0.92;

#[derive(Clone)]
pub struct Frame {
    pub amplitude: f32,
    pub peak: f32,
    pub bands: [f32; BANDS],
    pub stereo: Option<StereoFrame>,
}

#[derive(Clone)]
pub struct ChannelFrame {
    pub amplitude: f32,
    pub peak: f32,
    pub bands: [f32; BANDS],
}

impl Default for ChannelFrame {
    fn default() -> Self {
        Self {
            amplitude: 0.0,
            peak: 0.0,
            bands: [0.0; BANDS],
        }
    }
}

#[derive(Clone, Default)]
pub struct StereoFrame {
    pub left: ChannelFrame,
    pub right: ChannelFrame,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            amplitude: 0.0,
            peak: 0.0,
            bands: [0.0; BANDS],
            stereo: None,
        }
    }
}

/// Wire format shared with the frontend adapter: little-endian `f32`s, `[kind, amplitude, peak, band…]`.
pub const KIND_FRAME: f32 = 0.0;
pub const KIND_SOURCE_LOST: f32 = 1.0;
pub const KIND_HOST_DISABLED: f32 = 2.0;
pub const KIND_STEREO_FRAME: f32 = 3.0;
pub const MESSAGE_FLOATS: usize = 3 + BANDS;
pub const STEREO_MESSAGE_FLOATS: usize = MESSAGE_FLOATS + 2 * (2 + BANDS);

impl Frame {
    pub fn silence(stereo: bool) -> Self {
        Self {
            stereo: stereo.then(StereoFrame::default),
            ..Self::default()
        }
    }

    pub fn encode(&self, kind: f32) -> Vec<u8> {
        // Terminal messages and mono frames keep the original layout. Stereo has a distinct kind and fixed length.
        let stereo = (kind == KIND_FRAME)
            .then_some(self.stereo.as_ref())
            .flatten();
        let kind = if stereo.is_some() {
            KIND_STEREO_FRAME
        } else {
            kind
        };
        let mut bytes = Vec::with_capacity(
            if stereo.is_some() {
                STEREO_MESSAGE_FLOATS
            } else {
                MESSAGE_FLOATS
            } * 4,
        );
        for value in [kind, self.amplitude, self.peak]
            .iter()
            .chain(self.bands.iter())
        {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        if let Some(stereo) = stereo {
            for channel in [&stereo.left, &stereo.right] {
                for value in [channel.amplitude, channel.peak]
                    .iter()
                    .chain(channel.bands.iter())
                {
                    bytes.extend_from_slice(&value.to_le_bytes());
                }
            }
        }
        bytes
    }
}

/// Window length for a sample rate: about 40 ms, a power of two, so low bands stay resolved at 96/192 kHz.
fn fft_size(sample_rate: u32) -> usize {
    ((sample_rate / 24).max(1024) as usize)
        .next_power_of_two()
        .min(8192)
}

fn level(linear: f32) -> f32 {
    if linear <= 0.0 {
        return 0.0;
    }
    ((20.0 * linear.log10() - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB).clamp(0.0, 1.0)
}

/// Where a band reads from. Bands wider than a bin take the loudest bin inside; narrower ones (the whole bass, where
/// log spacing outruns the FFT) interpolate between the two bins around their centre instead, so the low end curves
/// smoothly rather than stepping across a handful of shared bins.
#[derive(Clone, Copy, Default)]
struct Band {
    start: usize,
    end: usize,
    /// Position between `start` and `start + 1`, used only by narrow bands (`end == start`).
    frac: f32,
}

struct ChannelAnalyzer {
    n: usize,
    ring: Vec<f32>,
    write: usize,
    filled: usize,
    window: Vec<f32>,
    cos: Vec<f32>,
    sin: Vec<f32>,
    bit_reverse: Vec<u32>,
    re: Vec<f32>,
    im: Vec<f32>,
    bands: [Band; BANDS],
    peak_hold: f32,
}

impl ChannelAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        let n = fft_size(sample_rate);
        let bits = n.trailing_zeros();
        let bit_reverse = (0..n as u32)
            .map(|i| i.reverse_bits() >> (32 - bits))
            .collect();
        // Blackman window, the one an AnalyserNode uses.
        let window = (0..n)
            .map(|i| {
                let x = 2.0 * PI * i as f32 / n as f32;
                0.42 - 0.5 * x.cos() + 0.08 * (2.0 * x).cos()
            })
            .collect();
        let cos = (0..n / 2)
            .map(|k| (2.0 * PI * k as f32 / n as f32).cos())
            .collect();
        let sin = (0..n / 2)
            .map(|k| -(2.0 * PI * k as f32 / n as f32).sin())
            .collect();

        let nyquist = sample_rate as f32 / 2.0;
        let top = HIGHEST_HZ.min(nyquist * 0.95);
        let bin_hz = sample_rate as f32 / n as f32;
        let mut bands = [Band::default(); BANDS];
        for (i, band) in bands.iter_mut().enumerate() {
            let edge = |step: usize| LOWEST_HZ * (top / LOWEST_HZ).powf(step as f32 / BANDS as f32);
            let (lo, hi) = (edge(i), edge(i + 1));
            let (first, last) = (
                (lo / bin_hz).ceil() as usize,
                (hi / bin_hz).floor() as usize,
            );
            *band = if last > first {
                Band {
                    start: first.max(1),
                    end: (last + 1).min(n / 2),
                    frac: 0.0,
                }
            } else {
                let at = (lo * hi).sqrt() / bin_hz;
                Band {
                    start: (at.floor() as usize).max(1),
                    end: 0,
                    frac: at - at.floor(),
                }
            };
        }

        Self {
            n,
            ring: vec![0.0; n],
            write: 0,
            filled: 0,
            window,
            cos,
            sin,
            bit_reverse,
            re: vec![0.0; n],
            im: vec![0.0; n],
            bands,
            peak_hold: 0.0,
        }
    }

    /// Downmix interleaved samples to mono into the ring. No allocation.
    pub fn push(&mut self, samples: &[f32], channels: usize) {
        let channels = channels.max(1);
        let scale = 1.0 / channels as f32;
        for frame in samples.chunks_exact(channels) {
            self.ring[self.write] = frame.iter().sum::<f32>() * scale;
            self.write += 1;
            if self.write == self.n {
                self.write = 0;
            }
        }
        self.filled = (self.filled + samples.len() / channels).min(self.n);
    }

    pub fn clear(&mut self) {
        self.ring.fill(0.0);
        self.write = 0;
        self.filled = 0;
        self.peak_hold = 0.0;
    }

    /// Analyse the latest window. Returns false (leaving `out` zeroed) before a full window has arrived.
    pub fn analyse(&mut self, out: &mut ChannelFrame) -> bool {
        *out = ChannelFrame::default();
        if self.filled < self.n {
            return false;
        }
        let n = self.n;
        let (mut sum_squares, mut loudest) = (0.0f32, 0.0f32);
        for i in 0..n {
            let sample = self.ring[(self.write + i) % n];
            sum_squares += sample * sample;
            loudest = loudest.max(sample.abs());
            self.re[i] = sample * self.window[i];
            self.im[i] = 0.0;
        }
        out.amplitude = level((sum_squares / n as f32).sqrt());
        self.peak_hold = level(loudest).max(self.peak_hold * PEAK_DECAY);
        out.peak = self.peak_hold;

        self.fft();

        // |X| / N, as an AnalyserNode scales it, mapped over its decibel window.
        let norm = 1.0 / n as f32;
        let power = |bin: usize| self.re[bin] * self.re[bin] + self.im[bin] * self.im[bin];
        for (value, band) in out.bands.iter_mut().zip(self.bands.iter()) {
            let strongest = if band.end > band.start {
                (band.start..band.end).fold(0.0f32, |loudest, bin| loudest.max(power(bin)))
            } else {
                let (a, b) = (power(band.start).sqrt(), power(band.start + 1).sqrt());
                let magnitude = a + (b - a) * band.frac;
                magnitude * magnitude
            };
            let magnitude = strongest.sqrt() * norm;
            *value = if magnitude > 0.0 {
                ((20.0 * magnitude.log10() - FLOOR_DB) / (CEIL_DB - FLOOR_DB)).clamp(0.0, 1.0)
            } else {
                0.0
            };
        }
        true
    }

    /// In-place iterative radix-2. Plenty fast for one 2048 – 8192 point transform per frame.
    fn fft(&mut self) {
        let n = self.n;
        for i in 0..n {
            let j = self.bit_reverse[i] as usize;
            if j > i {
                self.re.swap(i, j);
                self.im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let (half, stride) = (len / 2, n / len);
            for start in (0..n).step_by(len) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * stride], self.sin[k * stride]);
                    let (a, b) = (start + k, start + k + half);
                    let tr = self.re[b] * wr - self.im[b] * wi;
                    let ti = self.re[b] * wi + self.im[b] * wr;
                    self.re[b] = self.re[a] - tr;
                    self.im[b] = self.im[a] - ti;
                    self.re[a] += tr;
                    self.im[a] += ti;
                }
            }
            len *= 2;
        }
    }
}

/// Mono remains the exact mean of all captured channels. Stereo uses independent channel histories and peak holds.
pub struct Analyzer {
    mono: ChannelAnalyzer,
    stereo: Option<(ChannelAnalyzer, ChannelAnalyzer)>,
}

impl Analyzer {
    #[cfg(test)]
    pub fn new(sample_rate: u32) -> Self {
        Self::with_stereo(sample_rate, false)
    }

    pub fn with_stereo(sample_rate: u32, stereo: bool) -> Self {
        Self {
            mono: ChannelAnalyzer::new(sample_rate),
            stereo: stereo.then(|| {
                (
                    ChannelAnalyzer::new(sample_rate),
                    ChannelAnalyzer::new(sample_rate),
                )
            }),
        }
    }

    /// Used by mono and stereo capture devices. Mono inputs are duplicated in the optional stereo result.
    pub fn push(&mut self, samples: &[f32], channels: usize) {
        self.mono.push(samples, channels);
        if let Some((left, right)) = &mut self.stereo {
            assert!(
                channels == 1 || channels == 2,
                "Stereo requires a known channel layout"
            );
            for frame in samples.chunks_exact(channels) {
                left.push(&frame[..1], 1);
                right.push(&frame[channels - 1..channels], 1);
            }
        }
    }

    /// WASAPI retains its native channel count. A speaker-aware mix supplies the stereo view without changing mono.
    #[cfg(any(target_os = "windows", test))]
    pub fn push_mapped(&mut self, samples: &[f32], mix: &super::channels::StereoMix) {
        self.mono.push(samples, mix.channels());
        if let Some((left, right)) = &mut self.stereo {
            for frame in samples.chunks_exact(mix.channels()) {
                let (l, r) = mix.apply(frame);
                left.push(&[l], 1);
                right.push(&[r], 1);
            }
        }
    }

    pub fn clear(&mut self) {
        self.mono.clear();
        if let Some((left, right)) = &mut self.stereo {
            left.clear();
            right.clear();
        }
    }

    pub fn analyse(&mut self, out: &mut Frame) -> bool {
        *out = Frame::silence(self.stereo.is_some());
        let mut mono = ChannelFrame::default();
        if !self.mono.analyse(&mut mono) {
            return false;
        }
        out.amplitude = mono.amplitude;
        out.peak = mono.peak;
        out.bands = mono.bands;
        if let Some((left, right)) = &mut self.stereo {
            let stereo = out.stereo.as_mut().unwrap();
            left.analyse(&mut stereo.left);
            right.analyse(&mut stereo.right);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(rate: u32, hz: f32, amplitude: f32, frames: usize, channels: usize) -> Vec<f32> {
        (0..frames)
            .flat_map(|i| {
                let v = amplitude * (2.0 * PI * hz * i as f32 / rate as f32).sin();
                std::iter::repeat(v).take(channels)
            })
            .collect()
    }

    fn strongest_band(frame: &Frame) -> usize {
        (0..BANDS)
            .max_by(|&a, &b| frame.bands[a].total_cmp(&frame.bands[b]))
            .unwrap()
    }

    fn band_centre_hz(rate: u32, band: usize) -> f32 {
        let top = HIGHEST_HZ.min(rate as f32 / 2.0 * 0.95);
        let edge = |s: f32| LOWEST_HZ * (top / LOWEST_HZ).powf(s / BANDS as f32);
        (edge(band as f32) * edge(band as f32 + 1.0)).sqrt()
    }

    #[test]
    fn window_scales_with_sample_rate() {
        assert_eq!(fft_size(44_100), 2048);
        assert_eq!(fft_size(48_000), 2048);
        assert_eq!(fft_size(96_000), 4096);
        assert_eq!(fft_size(192_000), 8192);
    }

    #[test]
    fn waits_for_a_full_window() {
        let mut analyzer = Analyzer::new(48_000);
        let mut frame = Frame::default();
        analyzer.push(&tone(48_000, 440.0, 0.5, 1000, 2), 2);
        assert!(!analyzer.analyse(&mut frame));
        assert_eq!(frame.amplitude, 0.0);
        analyzer.push(&tone(48_000, 440.0, 0.5, 2000, 2), 2);
        assert!(analyzer.analyse(&mut frame));
    }

    #[test]
    fn a_tone_lights_the_band_that_contains_it() {
        for rate in [44_100u32, 48_000, 96_000] {
            for hz in [100.0f32, 440.0, 1_000.0, 5_000.0, 10_000.0] {
                let mut analyzer = Analyzer::new(rate);
                let mut frame = Frame::default();
                analyzer.push(&tone(rate, hz, 0.02, 8192, 2), 2);
                assert!(analyzer.analyse(&mut frame));
                let band = strongest_band(&frame);
                let centre = band_centre_hz(rate, band);
                // One band is ~7.5% wide; the tone must land within a band or two of its own.
                assert!(
                    (centre / hz - 1.0).abs() < 0.2,
                    "{hz} Hz at {rate}: band {band} is {centre:.0} Hz"
                );
                assert!(
                    frame.bands[band] > 0.5,
                    "{hz} Hz at {rate}: weak peak {}",
                    frame.bands[band]
                );
            }
        }
    }

    #[test]
    fn silence_is_zero_and_levels_follow_loudness() {
        let mut analyzer = Analyzer::new(48_000);
        let mut frame = Frame::default();
        analyzer.push(&vec![0.0; 4096], 1);
        assert!(analyzer.analyse(&mut frame));
        assert_eq!((frame.amplitude, frame.peak), (0.0, 0.0));
        assert!(frame.bands.iter().all(|&b| b == 0.0));

        analyzer.push(&tone(48_000, 440.0, 1.0, 4096, 1), 1);
        analyzer.analyse(&mut frame);
        let loud = frame.amplitude;
        analyzer.push(&tone(48_000, 440.0, 0.1, 4096, 1), 1);
        analyzer.analyse(&mut frame);
        assert!(loud > frame.amplitude && frame.amplitude > 0.0);
    }

    #[test]
    fn peak_decays_instead_of_dropping() {
        let mut analyzer = Analyzer::new(48_000);
        let mut frame = Frame::default();
        analyzer.push(&tone(48_000, 440.0, 1.0, 4096, 1), 1);
        analyzer.analyse(&mut frame);
        let held = frame.peak;
        analyzer.push(&vec![0.0; 4096], 1);
        analyzer.analyse(&mut frame);
        assert!(frame.peak < held && frame.peak > 0.0);
    }

    #[test]
    fn output_is_always_in_range_even_for_garbage() {
        let mut analyzer = Analyzer::new(48_000);
        let mut frame = Frame::default();
        let hot: Vec<f32> = (0..4096)
            .map(|i| if i % 2 == 0 { 50.0 } else { f32::MAX })
            .collect();
        analyzer.push(&hot, 1);
        analyzer.analyse(&mut frame);
        for value in frame
            .bands
            .iter()
            .chain([frame.amplitude, frame.peak].iter())
        {
            assert!((0.0..=1.0).contains(value), "{value}");
        }
    }

    #[test]
    fn encodes_a_fixed_little_endian_layout() {
        let mut frame = Frame::default();
        frame.amplitude = 0.5;
        frame.peak = 0.75;
        frame.bands[BANDS - 1] = 0.25;
        let bytes = frame.encode(KIND_HOST_DISABLED);
        assert_eq!(bytes.len(), MESSAGE_FLOATS * 4);
        let float = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!(
            (float(0), float(1), float(2), float(MESSAGE_FLOATS - 1)),
            (2.0, 0.5, 0.75, 0.25)
        );
    }

    #[test]
    fn stereo_separates_tones_and_keeps_the_original_mono_analysis() {
        for rate in [44_100, 48_000, 96_000, 192_000] {
            let left = tone(rate, 440.0, 0.02, 8192, 1);
            let right = tone(rate, 5000.0, 0.02, 8192, 1);
            let samples: Vec<f32> = left
                .iter()
                .zip(&right)
                .flat_map(|(&l, &r)| [l, r])
                .collect();
            let mut analyzer = Analyzer::with_stereo(rate, true);
            let mut mono = Analyzer::new(rate);
            analyzer.push(&samples, 2);
            mono.push(&samples, 2);
            let (mut frame, mut old) = (Frame::default(), Frame::default());
            assert!(analyzer.analyse(&mut frame) && mono.analyse(&mut old));
            assert_eq!(frame.bands, old.bands);
            assert_eq!((frame.amplitude, frame.peak), (old.amplitude, old.peak));
            assert!(mono.stereo.is_none());
            let stereo = frame.stereo.unwrap();
            let peak = |channel: &ChannelFrame| {
                (0..BANDS)
                    .max_by(|&a, &b| channel.bands[a].total_cmp(&channel.bands[b]))
                    .unwrap()
            };
            assert!((band_centre_hz(rate, peak(&stereo.left)) / 440.0 - 1.0).abs() < 0.2);
            assert!((band_centre_hz(rate, peak(&stereo.right)) / 5000.0 - 1.0).abs() < 0.2);
        }
    }

    #[test]
    fn opposite_phase_survives_in_stereo_while_mono_stays_silent() {
        let samples: Vec<f32> = tone(48_000, 440.0, 0.02, 4096, 1)
            .iter()
            .flat_map(|&l| [l, -l])
            .collect();
        let mut analyzer = Analyzer::with_stereo(48_000, true);
        analyzer.push(&samples, 2);
        let mut frame = Frame::default();
        assert!(analyzer.analyse(&mut frame));
        assert_eq!(frame.amplitude, 0.0);
        assert!(frame.bands.iter().all(|&b| b == 0.0));
        let stereo = frame.stereo.unwrap();
        assert!(stereo.left.amplitude > 0.0 && stereo.right.amplitude > 0.0);
        assert_eq!(stereo.left.bands, stereo.right.bands);
    }

    #[test]
    fn silent_side_has_no_leakage_and_clear_resets_both_peak_holds() {
        for side in [0, 1] {
            let samples: Vec<f32> = tone(48_000, 440.0, 0.02, 4096, 1)
                .iter()
                .flat_map(|&v| if side == 0 { [v, 0.0] } else { [0.0, v] })
                .collect();
            let mut analyzer = Analyzer::with_stereo(48_000, true);
            analyzer.push(&samples, 2);
            let mut frame = Frame::default();
            assert!(analyzer.analyse(&mut frame));
            let stereo = frame.stereo.as_ref().unwrap();
            let (loud, silent) = if side == 0 {
                (&stereo.left, &stereo.right)
            } else {
                (&stereo.right, &stereo.left)
            };
            assert!(loud.peak > 0.0);
            assert_eq!((silent.amplitude, silent.peak), (0.0, 0.0));
            assert!(silent.bands.iter().all(|&b| b == 0.0));
            analyzer.clear();
            assert!(!analyzer.analyse(&mut frame));
            analyzer.push(&vec![0.0; 8192], 2);
            assert!(analyzer.analyse(&mut frame));
            let stereo = frame.stereo.unwrap();
            assert_eq!((stereo.left.peak, stereo.right.peak), (0.0, 0.0));
        }
    }

    #[test]
    fn stereo_duplicates_a_mono_source_and_mapped_surround_keeps_mono_unchanged() {
        let samples = tone(48_000, 440.0, 0.02, 4096, 1);
        let mut analyzer = Analyzer::with_stereo(48_000, true);
        analyzer.push(&samples, 1);
        let mut frame = Frame::default();
        assert!(analyzer.analyse(&mut frame));
        let stereo = frame.stereo.as_ref().unwrap();
        assert_eq!(frame.bands, stereo.left.bands);
        assert_eq!(stereo.left.bands, stereo.right.bands);

        let surround: Vec<f32> = samples
            .iter()
            .flat_map(|&v| [0.0, 0.0, v, 0.0, 0.0, 0.0])
            .collect();
        let mix = super::super::channels::StereoMix::new(6, 0x3f).unwrap();
        let mut analyzer = Analyzer::with_stereo(48_000, true);
        let mut mono = Analyzer::new(48_000);
        analyzer.push_mapped(&surround, &mix);
        mono.push(&surround, 6);
        let mut old = Frame::default();
        analyzer.analyse(&mut frame);
        mono.analyse(&mut old);
        assert_eq!(frame.bands, old.bands);
        let stereo = frame.stereo.unwrap();
        assert!(stereo.left.amplitude > 0.0 && stereo.right.amplitude > 0.0);
        assert_eq!(stereo.left.bands, stereo.right.bands);
    }

    #[test]
    fn stereo_wire_layout_has_distinct_kind_and_fixed_channel_offsets() {
        let mut frame = Frame::silence(true);
        frame.amplitude = 0.1;
        let stereo = frame.stereo.as_mut().unwrap();
        stereo.left.amplitude = 0.2;
        stereo.left.bands[0] = 0.3;
        stereo.right.peak = 0.4;
        stereo.right.bands[BANDS - 1] = 0.5;
        let bytes = frame.encode(KIND_FRAME);
        assert_eq!(bytes.len(), STEREO_MESSAGE_FLOATS * 4);
        let at = |i: usize| f32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap());
        assert_eq!(
            (at(0), at(1), at(MESSAGE_FLOATS), at(MESSAGE_FLOATS + 2)),
            (3.0, 0.1, 0.2, 0.3)
        );
        assert_eq!(
            (
                at(MESSAGE_FLOATS + 2 + BANDS + 1),
                at(STEREO_MESSAGE_FLOATS - 1)
            ),
            (0.4, 0.5)
        );
        for kind in [KIND_SOURCE_LOST, KIND_HOST_DISABLED] {
            assert_eq!(frame.encode(kind).len(), MESSAGE_FLOATS * 4);
        }
    }
}
