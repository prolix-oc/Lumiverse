//! Speaker-aware stereo downmix for native Windows output formats. No channel positions are guessed for surround.

pub struct StereoMix {
    weights: Vec<(f32, f32)>,
    scale: f32,
}

impl StereoMix {
    pub fn new(channels: usize, mask: u32) -> Option<Self> {
        if channels == 0 || channels > 32 {
            return None;
        }
        if mask == 0 {
            return match channels {
                1 => Some(Self {
                    weights: vec![(1.0, 1.0)],
                    scale: 1.0,
                }),
                2 => Some(Self {
                    weights: vec![(1.0, 0.0), (0.0, 1.0)],
                    scale: 1.0,
                }),
                _ => None,
            };
        }
        if mask.count_ones() as usize != channels || mask & !0x3ffff != 0 {
            return None;
        }
        if channels == 1 {
            return Some(Self {
                weights: vec![(1.0, 1.0)],
                scale: 1.0,
            });
        }
        let mut weights = Vec::with_capacity(channels);
        let side = std::f32::consts::FRAC_1_SQRT_2;
        for bit in 0..18 {
            if mask & (1 << bit) == 0 {
                continue;
            }
            weights.push(match bit {
                0 | 6 => (1.0, 0.0),   // front left / front left of centre
                1 | 7 => (0.0, 1.0),   // front right / front right of centre
                2 => (side, side),     // front centre
                3 => (0.0, 0.0),       // LFE omitted from the stereo view
                4 | 9 => (side, 0.0),  // back / side left
                5 | 10 => (0.0, side), // back / side right
                12 | 15 => (0.5, 0.0), // height left
                14 | 17 => (0.0, 0.5), // height right
                _ => (0.5, 0.5),       // back / height centre
            });
        }
        let (left, right) = weights
            .iter()
            .fold((0.0f32, 0.0f32), |(l, r), &(a, b)| (l + a, r + b));
        // One shared normalisation preserves balance and prevents clipping with several coherent speakers.
        Some(Self {
            weights,
            scale: 1.0 / left.max(right).max(1.0),
        })
    }

    pub fn channels(&self) -> usize {
        self.weights.len()
    }

    pub fn apply(&self, frame: &[f32]) -> (f32, f32) {
        let (left, right) = frame
            .iter()
            .zip(&self.weights)
            .fold((0.0, 0.0), |(l, r), (&sample, &(a, b))| {
                (l + sample * a, r + sample * b)
            });
        (left * self.scale, right * self.scale)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mono_duplicates_and_stereo_preserves_sides() {
        assert_eq!(StereoMix::new(1, 0).unwrap().apply(&[0.4]), (0.4, 0.4));
        for mask in [0, 3] {
            let mix = StereoMix::new(2, mask).unwrap();
            assert_eq!(mix.apply(&[0.4, 0.0]), (0.4, 0.0));
            assert_eq!(mix.apply(&[0.0, 0.7]), (0.0, 0.7));
        }
    }

    #[test]
    fn surround_keeps_centre_and_side_content_without_clipping() {
        for mask in [0x3fu32, 0x60f, 0x63f] {
            // 5.1 rear, 5.1 side, 7.1
            let mix = StereoMix::new(mask.count_ones() as usize, mask).unwrap();
            let mut frame = vec![0.0; mix.channels()];
            frame[2] = 1.0;
            let (l, r) = mix.apply(&frame);
            assert!(l > 0.0 && l == r);
            frame.fill(0.0);
            frame[4] = 1.0;
            let (l, r) = mix.apply(&frame);
            assert!(l > 0.0 && r == 0.0);
            let (l, r) = mix.apply(&vec![1.0; mix.channels()]);
            assert!(l <= 1.0 && r <= 1.0);
            frame.fill(0.0);
            frame[3] = 1.0;
            assert_eq!(mix.apply(&frame), (0.0, 0.0));
        }
    }

    #[test]
    fn channel_mask_controls_order_even_without_front_right() {
        let mix = StereoMix::new(2, 5).unwrap(); // FL, FC; channel 1 is not right
        let (l, r) = mix.apply(&[0.0, 1.0]);
        assert!(l > 0.0 && l == r);
    }

    #[test]
    fn unknown_or_inconsistent_surround_layouts_are_rejected() {
        for (channels, mask) in [(0, 0), (33, 0), (6, 0), (6, 3), (2, 0x80000001)] {
            assert!(StereoMix::new(channels, mask).is_none());
        }
    }
}
