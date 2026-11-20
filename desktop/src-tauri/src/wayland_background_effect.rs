//! Temporary `ext-background-effect-v1` integration for Tauri's GTK runtime.
//!
//! GTK owns both the Wayland connection and the `wl_surface`. The Rust
//! Wayland client is therefore attached to those foreign objects rather than
//! opening a second connection (objects from different connections cannot be
//! mixed). All access is dispatched onto GTK's main thread.

use gtk::prelude::*;
use raw_window_handle::{HasDisplayHandle, HasWindowHandle, RawDisplayHandle, RawWindowHandle};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::WebviewWindow;
use wayland_client::{
    backend::{Backend, ObjectId},
    globals::{registry_queue_init, GlobalList, GlobalListContents},
    protocol::{
        wl_compositor::WlCompositor, wl_region::WlRegion, wl_registry::WlRegistry,
        wl_surface::WlSurface,
    },
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
};
use wayland_protocols::ext::background_effect::v1::client::{
    ext_background_effect_manager_v1::{
        Event as BackgroundEffectManagerEvent, ExtBackgroundEffectManagerV1,
    },
    ext_background_effect_surface_v1::ExtBackgroundEffectSurfaceV1,
};

const CORNER_RADIUS: i32 = 12;

// Tauri can emit several resize and scale-factor events before GTK services
// its main-thread queue. Only the newest allocated size matters because the
// blur region is double-buffered with the next wl_surface commit.
static REFRESH_QUEUED: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
struct WaylandEffectState {
    can_blur: bool,
}

impl Dispatch<WlRegistry, GlobalListContents> for WaylandEffectState {
    fn event(
        _state: &mut Self,
        _proxy: &WlRegistry,
        _event: <WlRegistry as Proxy>::Event,
        _data: &GlobalListContents,
        _connection: &Connection,
        _queue: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlCompositor, ()> for WaylandEffectState {
    fn event(
        _state: &mut Self,
        _proxy: &WlCompositor,
        _event: <WlCompositor as Proxy>::Event,
        _data: &(),
        _connection: &Connection,
        _queue: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<WlRegion, ()> for WaylandEffectState {
    fn event(
        _state: &mut Self,
        _proxy: &WlRegion,
        _event: <WlRegion as Proxy>::Event,
        _data: &(),
        _connection: &Connection,
        _queue: &QueueHandle<Self>,
    ) {
    }
}

impl Dispatch<ExtBackgroundEffectManagerV1, ()> for WaylandEffectState {
    fn event(
        state: &mut Self,
        _proxy: &ExtBackgroundEffectManagerV1,
        event: BackgroundEffectManagerEvent,
        _data: &(),
        _connection: &Connection,
        _queue: &QueueHandle<Self>,
    ) {
        if let BackgroundEffectManagerEvent::Capabilities { flags } = event {
            let flags: u32 = flags.into();
            state.can_blur = flags & 1 != 0;
        }
    }
}

impl Dispatch<ExtBackgroundEffectSurfaceV1, ()> for WaylandEffectState {
    fn event(
        _state: &mut Self,
        _proxy: &ExtBackgroundEffectSurfaceV1,
        _event: <ExtBackgroundEffectSurfaceV1 as Proxy>::Event,
        _data: &(),
        _connection: &Connection,
        _queue: &QueueHandle<Self>,
    ) {
    }
}

struct WaylandEffectContext {
    display: usize,
    connection: Connection,
    _globals: GlobalList,
    event_queue: EventQueue<WaylandEffectState>,
    state: WaylandEffectState,
    compositor: WlCompositor,
    manager: Option<ExtBackgroundEffectManagerV1>,
    effects: HashMap<ObjectId, ExtBackgroundEffectSurfaceV1>,
    effect_sizes: HashMap<ObjectId, (i32, i32)>,
}

impl WaylandEffectContext {
    unsafe fn new(display: *mut std::ffi::c_void) -> Result<Self, String> {
        // SAFETY: raw-window-handle obtained this pointer from Tauri's live GTK
        // event loop. Backend does not own or disconnect a foreign display.
        let backend = unsafe { Backend::from_foreign_display(display.cast()) };
        let connection = Connection::from_backend(backend);
        let (globals, mut event_queue) = registry_queue_init::<WaylandEffectState>(&connection)
            .map_err(|error| format!("could not read Wayland globals: {error}"))?;
        let queue = event_queue.handle();
        let compositor = globals
            .bind::<WlCompositor, _, _>(&queue, 1..=6, ())
            .map_err(|error| format!("could not bind wl_compositor: {error}"))?;
        let manager = globals
            .bind::<ExtBackgroundEffectManagerV1, _, _>(&queue, 1..=1, ())
            .ok();
        let mut state = WaylandEffectState::default();

        // Binding the manager immediately emits its capability set. Complete
        // one setup roundtrip so the first requested effect never races it.
        if manager.is_some() {
            event_queue.roundtrip(&mut state).map_err(|error| {
                format!("could not read background-effect capabilities: {error}")
            })?;
        }

        Ok(Self {
            display: display as usize,
            connection,
            _globals: globals,
            event_queue,
            state,
            compositor,
            manager,
            effects: HashMap::new(),
            effect_sizes: HashMap::new(),
        })
    }

    fn refresh_events(&mut self) -> Result<(), String> {
        self.event_queue
            .dispatch_pending(&mut self.state)
            .map(|_| ())
            .map_err(|error| format!("could not dispatch background-effect events: {error}"))
    }

    fn surface_proxy(&self, surface: *mut std::ffi::c_void) -> Result<WlSurface, String> {
        // SAFETY: the pointer is borrowed from the same live display wrapped by
        // `self.connection`, and the proxy is never destroyed by this module.
        let object_id = unsafe { ObjectId::from_ptr(WlSurface::interface(), surface.cast()) }
            .map_err(|_| "GTK returned an invalid wl_surface".to_string())?;
        WlSurface::from_id(&self.connection, object_id)
            .map_err(|_| "could not wrap GTK's wl_surface".to_string())
    }

    fn set(
        &mut self,
        surface_pointer: *mut std::ffi::c_void,
        width: i32,
        height: i32,
        enabled: bool,
    ) -> Result<bool, String> {
        self.refresh_events()?;
        let surface = self.surface_proxy(surface_pointer)?;
        // ObjectId includes the object's generation, unlike either its raw
        // address or protocol number, both of which Wayland may reuse.
        let surface_key = surface.id();

        if !enabled {
            if let Some(effect) = self.effects.remove(&surface_key) {
                self.effect_sizes.remove(&surface_key);
                effect.destroy();
                self.connection.flush().map_err(|error| {
                    format!("could not flush background-effect removal: {error}")
                })?;
                return Ok(true);
            }
            self.effect_sizes.remove(&surface_key);
            return Ok(false);
        }

        let Some(manager) = self.manager.as_ref() else {
            return Ok(false);
        };
        if !self.state.can_blur {
            return Ok(false);
        }

        let size = normalized_surface_size(width, height);
        if !effect_region_needs_update(
            self.effects.contains_key(&surface_key),
            self.effect_sizes.get(&surface_key).copied(),
            size,
        ) {
            return Ok(false);
        }

        let queue = self.event_queue.handle();
        let effect = self
            .effects
            .entry(surface_key.clone())
            .or_insert_with(|| manager.get_background_effect(&surface, &queue, ()));
        let region = self.compositor.create_region(&queue, ());
        add_rounded_region(&region, size.0, size.1);
        effect.set_blur_region(Some(&region));
        region.destroy();
        self.connection
            .flush()
            .map_err(|error| format!("could not flush background-effect update: {error}"))?;
        self.effect_sizes.insert(surface_key, size);
        Ok(true)
    }

    fn refresh(
        &mut self,
        surface_pointer: *mut std::ffi::c_void,
        width: i32,
        height: i32,
    ) -> Result<(), String> {
        let surface_key = self.surface_proxy(surface_pointer)?.id();
        if !self.effects.contains_key(&surface_key) {
            return Ok(());
        }
        self.set(surface_pointer, width, height, true).map(|_| ())
    }

    fn clear(&mut self) -> Result<(), String> {
        for (_, effect) in self.effects.drain() {
            effect.destroy();
        }
        self.effect_sizes.clear();
        self.connection
            .flush()
            .map_err(|error| format!("could not flush background-effect cleanup: {error}"))
    }
}

fn normalized_surface_size(width: i32, height: i32) -> (i32, i32) {
    (width.max(1), height.max(1))
}

fn effect_region_needs_update(
    effect_exists: bool,
    cached_size: Option<(i32, i32)>,
    requested_size: (i32, i32),
) -> bool {
    !effect_exists || cached_size != Some(requested_size)
}

thread_local! {
    static WAYLAND_EFFECT_CONTEXT: RefCell<Option<WaylandEffectContext>> = const { RefCell::new(None) };
}

fn add_rounded_region(region: &WlRegion, width: i32, height: i32) {
    for (x, y, width, height) in rounded_region_rectangles(width, height) {
        region.add(x, y, width, height);
    }
}

fn rounded_region_rectangles(width: i32, height: i32) -> Vec<(i32, i32, i32, i32)> {
    let width = width.max(1);
    let height = height.max(1);
    let radius = CORNER_RADIUS.min(width / 2).min(height / 2);
    if radius <= 1 {
        return vec![(0, 0, width, height)];
    }

    // wl_region has rectangles rather than paths. Horizontal corner bands
    // closely follow the same 12px rounded rectangle used by the web shell.
    // Merge adjacent rows with the same inset to preserve the exact rasterized
    // shape with fewer protocol requests.
    let inset_at = |y: i32| {
        let distance = radius as f64 - y as f64 - 0.5;
        (radius as f64 - ((radius * radius) as f64 - distance * distance).sqrt()).ceil() as i32
    };

    let mut rectangles = Vec::with_capacity((radius as usize) * 2 + 1);
    let middle_height = height - radius * 2;
    if middle_height > 0 {
        rectangles.push((0, radius, width, middle_height));
    }

    let mut band_start = 0;
    let mut band_inset = inset_at(0);
    for y in 1..=radius {
        let next_inset = (y < radius).then(|| inset_at(y));
        if next_inset == Some(band_inset) {
            continue;
        }

        let band_height = y - band_start;
        let row_width = (width - band_inset * 2).max(1);
        rectangles.push((band_inset, band_start, row_width, band_height));
        rectangles.push((band_inset, height - y, row_width, band_height));

        if let Some(inset) = next_inset {
            band_start = y;
            band_inset = inset;
        }
    }

    rectangles
}

fn wayland_handles(
    window: &WebviewWindow,
) -> Result<Option<(*mut std::ffi::c_void, *mut std::ffi::c_void)>, String> {
    let display = window
        .display_handle()
        .map_err(|error| format!("could not access display handle: {error}"))?;
    let surface = window
        .window_handle()
        .map_err(|error| format!("could not access window handle: {error}"))?;

    match (display.as_raw(), surface.as_raw()) {
        (RawDisplayHandle::Wayland(display), RawWindowHandle::Wayland(surface)) => {
            Ok(Some((display.display.as_ptr(), surface.surface.as_ptr())))
        }
        _ => Ok(None),
    }
}

fn surface_size(window: &WebviewWindow) -> Result<(i32, i32), String> {
    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    Ok((gtk_window.allocated_width(), gtk_window.allocated_height()))
}

pub fn set_background_effect(window: &WebviewWindow, enabled: bool) -> Result<(), String> {
    let effect_window = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let Some((display, surface)) = wayland_handles(&effect_window)? else {
                    return Ok(());
                };
                let (width, height) = surface_size(&effect_window)?;
                let changed = WAYLAND_EFFECT_CONTEXT.with(|slot| -> Result<bool, String> {
                    let mut slot = slot.borrow_mut();
                    if !enabled && slot.is_none() {
                        return Ok(false);
                    }
                    let replace = slot
                        .as_ref()
                        .is_some_and(|context| context.display != display as usize);
                    if replace {
                        if let Some(context) = slot.as_mut() {
                            let _ = context.clear();
                        }
                        *slot = None;
                    }
                    if slot.is_none() {
                        // SAFETY: `display` is the live Wayland display borrowed
                        // from Tauri above and this closure runs on GTK's thread.
                        *slot = Some(unsafe { WaylandEffectContext::new(display)? });
                    }
                    slot.as_mut()
                        .expect("Wayland context was just initialized")
                        .set(surface, width, height, enabled)
                })?;

                // The effect is double-buffered wl_surface state. Ask GTK to
                // paint instead of committing its surface behind its back.
                // Avoid a redraw when Linux ignores an appearance-only option
                // such as blur intensity and the effective region is unchanged.
                if changed {
                    if let Ok(gtk_window) = effect_window.gtk_window() {
                        gtk_window.queue_draw();
                    }
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                eprintln!("[desktop-appearance] Wayland background effect failed: {error}");
            }
        })
        .map_err(|error| error.to_string())
}

pub fn refresh_background_effect(window: &WebviewWindow) -> Result<(), String> {
    if REFRESH_QUEUED.swap(true, Ordering::AcqRel) {
        return Ok(());
    }

    let effect_window = window.clone();
    let scheduled = window.run_on_main_thread(move || {
        let result = (|| {
            let Some((_display, surface)) = wayland_handles(&effect_window)? else {
                return Ok(());
            };
            let (width, height) = surface_size(&effect_window)?;
            WAYLAND_EFFECT_CONTEXT.with(|slot| {
                let mut slot = slot.borrow_mut();
                if let Some(context) = slot.as_mut() {
                    context.refresh(surface, width, height)?;
                }
                Ok::<(), String>(())
            })
        })();
        REFRESH_QUEUED.store(false, Ordering::Release);
        if let Err(error) = result {
            eprintln!("[desktop-appearance] Wayland background-effect resize failed: {error}");
        }
    });
    if scheduled.is_err() {
        REFRESH_QUEUED.store(false, Ordering::Release);
    }
    scheduled.map_err(|error| error.to_string())
}

pub fn clear_background_effects(window: &WebviewWindow) -> Result<(), String> {
    window
        .run_on_main_thread(|| {
            WAYLAND_EFFECT_CONTEXT.with(|slot| {
                if let Some(context) = slot.borrow_mut().as_mut() {
                    if let Err(error) = context.clear() {
                        eprintln!(
                            "[desktop-appearance] Wayland background-effect cleanup failed: {error}"
                        );
                    }
                }
            });
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        effect_region_needs_update, normalized_surface_size, rounded_region_rectangles,
        CORNER_RADIUS,
    };

    #[test]
    fn normalizes_empty_surface_sizes_before_caching_them() {
        assert_eq!(normalized_surface_size(0, 0), (1, 1));
        assert_eq!(normalized_surface_size(-10, 720), (1, 720));
        assert_eq!(normalized_surface_size(1280, -10), (1280, 1));
        assert_eq!(normalized_surface_size(1280, 720), (1280, 720));
    }

    #[test]
    fn updates_only_new_or_resized_effect_regions() {
        assert!(effect_region_needs_update(false, None, (1280, 720)));
        assert!(effect_region_needs_update(
            false,
            Some((1280, 720)),
            (1280, 720)
        ));
        assert!(effect_region_needs_update(
            true,
            Some((1280, 720)),
            (1920, 1080)
        ));
        assert!(!effect_region_needs_update(
            true,
            Some((1280, 720)),
            (1280, 720)
        ));
    }

    #[test]
    fn rounded_region_merges_equal_corner_rows_without_changing_coverage() {
        let width = 1280;
        let height = 720;
        let rectangles = rounded_region_rectangles(width, height);

        assert!(rectangles.len() < (CORNER_RADIUS as usize) * 2 + 1);
        assert!(rectangles
            .iter()
            .all(|&(_, _, rect_width, rect_height)| rect_width > 0 && rect_height > 0));

        for y in 0..height {
            let row_rectangles: Vec<_> = rectangles
                .iter()
                .filter(|&&(_, top, _, rect_height)| y >= top && y < top + rect_height)
                .collect();
            assert_eq!(row_rectangles.len(), 1, "row {y}");

            let expected_inset = if y < CORNER_RADIUS {
                rounded_inset(y)
            } else if y >= height - CORNER_RADIUS {
                rounded_inset(height - y - 1)
            } else {
                0
            };
            assert_eq!(row_rectangles[0].0, expected_inset, "row {y}");
            assert_eq!(row_rectangles[0].2, width - expected_inset * 2, "row {y}");
        }
    }

    fn rounded_inset(y: i32) -> i32 {
        let distance = CORNER_RADIUS as f64 - y as f64 - 0.5;
        (CORNER_RADIUS as f64
            - ((CORNER_RADIUS * CORNER_RADIUS) as f64 - distance * distance).sqrt())
        .ceil() as i32
    }
}
