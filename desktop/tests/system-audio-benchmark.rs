//! Run from the repo root:
//! rustc --edition=2021 -O desktop/tests/system-audio-benchmark.rs -o /tmp/lumiverse-audio-bench
//! /tmp/lumiverse-audio-bench
#![allow(dead_code)]

#[path = "../src-tauri/src/system_audio/analyzer.rs"]
mod analyzer;
#[path = "../src-tauri/src/system_audio/channels.rs"]
mod channels;

use analyzer::{Analyzer, Frame, KIND_FRAME};
use std::{f32::consts::TAU, hint::black_box, time::Instant};

fn main() {
    println!("sample rate | mode   | microseconds/frame | one-core budget at 30 fps");
    for rate in [48_000, 96_000, 192_000] {
        let samples: Vec<f32> = (0..rate / 30)
            .flat_map(|i| {
                [
                    0.02 * (TAU * 440.0 * i as f32 / rate as f32).sin(),
                    0.02 * (TAU * 5000.0 * i as f32 / rate as f32).sin(),
                ]
            })
            .collect();
        for stereo in [false, true] {
            let mut analyzer = Analyzer::with_stereo(rate, stereo);
            let mut frame = Frame::default();
            for _ in 0..10 {
                analyzer.push(&samples, 2);
                analyzer.analyse(&mut frame);
            }
            let started = Instant::now();
            let iterations = 3000;
            for _ in 0..iterations {
                analyzer.push(black_box(&samples), 2);
                assert!(analyzer.analyse(&mut frame));
                black_box(frame.encode(KIND_FRAME));
            }
            let seconds = started.elapsed().as_secs_f64() / iterations as f64;
            println!(
                "{rate:>11} | {:6} | {:18.2} | {:>6.3}%",
                if stereo { "stereo" } else { "mono" },
                seconds * 1e6,
                seconds * 30.0 * 100.0
            );
        }
    }
}
