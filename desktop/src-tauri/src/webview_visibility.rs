//! Keep WebView2 controller visibility in step with its native window and display.
//!
//! Hiding a Tauri WebviewWindow hides its HWND, but does not explicitly hide the
//! WebView2 controller. IsVisible=false stops rendering without suspending page
//! scripts, streaming, or the tray's background work.
//! Inactive views also use WebView2's low memory target, which permits cache
//! reclamation while preserving those scripts and network connections.

#[derive(Clone, Copy)]
struct DisplayVisibility {
    on: bool,
}

impl Default for DisplayVisibility {
    fn default() -> Self {
        Self { on: true }
    }
}

impl DisplayVisibility {
    fn power_changed(&mut self, value: u32) {
        match value {
            0 => self.on = false,
            // A dimmed display is still visible. Ignore unrecognized values.
            1 | 2 => self.on = true,
            _ => {}
        }
    }

    fn should_render(self, window_visible: bool, minimized: bool) -> bool {
        self.on && window_visible && !minimized
    }
}

#[cfg(target_os = "windows")]
pub fn init() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    // Install once at creation for every WebView, including the hidden tray
    // host, floating widgets, and dialogs. Page navigation does not affect it.
    tauri::plugin::Builder::new("webview-visibility")
        .on_webview_ready(|webview| native::install(&webview))
        .build()
}

#[cfg(target_os = "windows")]
mod native {
    use super::DisplayVisibility;
    use std::{
        cell::Cell,
        rc::Rc,
        sync::atomic::{AtomicBool, Ordering},
    };
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::{
        core::{Interface, Result},
        Win32::{
            Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM},
            System::{
                Power::{
                    RegisterPowerSettingNotification, UnregisterPowerSettingNotification,
                    HPOWERNOTIFY, POWERBROADCAST_SETTING,
                },
                SystemServices::GUID_SESSION_DISPLAY_STATUS,
            },
            UI::{
                Shell::{
                    DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass,
                },
                WindowsAndMessaging::{
                    GetAncestor, IsIconic, IsWindowVisible, DEVICE_NOTIFY_WINDOW_HANDLE, GA_ROOT,
                    PBT_POWERSETTINGCHANGE, WM_NCDESTROY, WM_POWERBROADCAST, WM_SIZE,
                    WM_WINDOWPOSCHANGED,
                },
            },
        },
    };

    // A window created while the display is asleep inherits the last known
    // session state until its own power notification arrives.
    static SESSION_DISPLAY_ON: AtomicBool = AtomicBool::new(true);

    struct WindowVisibility {
        display: Cell<DisplayVisibility>,
        applied: Cell<Option<bool>>,
        destroyed: Cell<bool>,
        notification: Cell<Option<HPOWERNOTIFY>>,
        set_visible: Box<dyn Fn(bool) -> Result<()>>,
    }

    impl WindowVisibility {
        unsafe fn sync(&self, window: HWND) {
            if self.destroyed.get() {
                return;
            }
            let visible = self.display.get().should_render(
                IsWindowVisible(window).as_bool(),
                IsIconic(window).as_bool(),
            );
            self.apply(visible);
        }

        fn apply(&self, visible: bool) {
            if self.destroyed.get() {
                return;
            }
            if self.applied.get() == Some(visible) {
                return;
            }

            // COM can dispatch nested window messages. Record the transition
            // first so reentry cannot repeatedly apply the same visibility.
            self.applied.set(Some(visible));
            if let Err(error) = (self.set_visible)(visible) {
                if self.applied.get() == Some(visible) {
                    self.applied.set(None); // Retry on the next native transition.
                }
                eprintln!("[webview-visibility] could not set controller visibility: {error}");
            }
        }

        fn unregister(&self) {
            if let Some(notification) = self.notification.take() {
                unsafe {
                    let _ = UnregisterPowerSettingNotification(notification);
                }
            }
        }
    }

    impl Drop for WindowVisibility {
        fn drop(&mut self) {
            self.unregister();
        }
    }

    unsafe fn display_power_state(parameter: LPARAM) -> Option<u32> {
        let setting = (parameter.0 as *const POWERBROADCAST_SETTING).as_ref()?;
        if setting.PowerSetting != GUID_SESSION_DISPLAY_STATUS
            || setting.DataLength != std::mem::size_of::<u32>() as u32
        {
            return None;
        }
        // Data is a variable-length byte array in the Win32 structure.
        Some(
            std::ptr::addr_of!(setting.Data)
                .cast::<u32>()
                .read_unaligned(),
        )
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        data: usize,
    ) -> LRESULT {
        let pointer = data as *const WindowVisibility;
        // Hold a separate reference across COM/DefSubclassProc calls: either
        // can dispatch WM_NCDESTROY reentrantly and release the subclass owner.
        Rc::increment_strong_count(pointer);
        let state = Rc::from_raw(pointer);
        match message {
            WM_NCDESTROY => {
                state.destroyed.set(true);
                let _ = RemoveWindowSubclass(window, Some(window_proc), id);
                state.unregister();
                drop(Rc::from_raw(pointer));
            }
            WM_POWERBROADCAST if wparam.0 == PBT_POWERSETTINGCHANGE as usize => {
                if let Some(value) = display_power_state(lparam) {
                    let mut display = state.display.get();
                    display.power_changed(value);
                    SESSION_DISPLAY_ON.store(display.on, Ordering::Relaxed);
                    state.display.set(display);
                    state.sync(window);
                }
            }
            // WINDOWPOSCHANGED observes show/hide after the HWND flags change;
            // WM_SHOWWINDOW is sent before that change. SIZE covers restore and
            // minimize, including transitions initiated outside our commands.
            WM_WINDOWPOSCHANGED | WM_SIZE => state.sync(window),
            _ => {}
        }
        DefSubclassProc(window, message, wparam, lparam)
    }

    /// Idempotent across navigation/reload. with_webview runs on the owning UI
    /// thread, as required by both the controller and Win32 subclass helpers.
    pub fn install(webview: &tauri::Webview) {
        let result = webview.with_webview(|platform| unsafe {
            let controller = platform.controller();
            let mut parent = HWND::default();
            if let Err(error) = controller.ParentWindow(&mut parent) {
                eprintln!("[webview-visibility] could not get controller window: {error}");
                return;
            }
            // Wry hosts the controller in a child HWND. Watch the top-level
            // window: child windows do not receive its minimize/show messages,
            // and IsIconic on the controller's parent would always be false.
            // GA_ROOT preserves each popup's identity, unlike GA_ROOTOWNER.
            let window = GetAncestor(parent, GA_ROOT);
            if window.0.is_null() {
                eprintln!("[webview-visibility] could not find the top-level window");
                return;
            }
            // Use the controller's host HWND as its ID so multiple WebViews in
            // one native window can each track that window independently.
            let id = parent.0 as usize;
            if GetWindowSubclass(window, Some(window_proc), id, None).as_bool() {
                return;
            }

            // Query once: older WebView2 runtimes still get visibility handling.
            let memory_target = controller
                .CoreWebView2()
                .ok()
                .and_then(|core| core.cast::<ICoreWebView2_19>().ok());

            let state = Rc::new(WindowVisibility {
                display: Cell::new(DisplayVisibility {
                    on: SESSION_DISPLAY_ON.load(Ordering::Relaxed),
                }),
                applied: Cell::new(None),
                destroyed: Cell::new(false),
                notification: Cell::new(None),
                set_visible: Box::new(move |visible| {
                    controller.SetIsVisible(visible)?;
                    if let Some(core) = &memory_target {
                        let level = if visible {
                            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                        } else {
                            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                        };
                        // Failure to trim must never interfere with showing the
                        // window. Do not suspend: generations/audio may be live.
                        if let Err(error) = core.SetMemoryUsageTargetLevel(level) {
                            eprintln!("[webview-visibility] could not set memory target: {error}");
                        }
                    }
                    Ok(())
                }),
            });
            let pointer = Rc::into_raw(state.clone());
            if !SetWindowSubclass(window, Some(window_proc), id, pointer as usize).as_bool() {
                drop(Rc::from_raw(pointer));
                eprintln!("[webview-visibility] could not watch native window visibility");
                return;
            }

            // Use the interactive session's display state, including remote
            // sessions, rather than the console-only monitor notification.
            match RegisterPowerSettingNotification(
                HANDLE(window.0),
                &GUID_SESSION_DISPLAY_STATUS,
                DEVICE_NOTIFY_WINDOW_HANDLE,
            ) {
                Ok(notification) => {
                    state.notification.set(Some(notification));
                    if state.destroyed.get() {
                        state.unregister();
                    }
                }
                Err(error) => {
                    // Window hide/minimize handling remains useful if power
                    // registration fails; do not prevent the app from opening.
                    eprintln!("[webview-visibility] could not watch display power: {error}");
                }
            }
            state.sync(window);
        });
        if let Err(error) = result {
            eprintln!("[webview-visibility] could not access native WebView: {error}");
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::cell::RefCell;
        use windows::core::{Error, GUID, HRESULT};

        fn state(set_visible: impl Fn(bool) -> Result<()> + 'static) -> WindowVisibility {
            WindowVisibility {
                display: Cell::new(DisplayVisibility::default()),
                applied: Cell::new(None),
                destroyed: Cell::new(false),
                notification: Cell::new(None),
                set_visible: Box::new(set_visible),
            }
        }

        #[test]
        fn accepts_only_session_display_notifications_with_a_dword_payload() {
            #[repr(C)]
            struct Notification {
                setting: GUID,
                length: u32,
                value: u32,
            }
            let mut notification = Notification {
                setting: GUID_SESSION_DISPLAY_STATUS,
                length: 4,
                value: 2,
            };
            let read = |notification: &Notification| unsafe {
                display_power_state(LPARAM(std::ptr::from_ref(notification) as isize))
            };
            unsafe {
                assert_eq!(display_power_state(LPARAM(0)), None);
            }
            assert_eq!(read(&notification), Some(2));
            notification.length = 1;
            assert_eq!(read(&notification), None);
            notification.length = 4;
            notification.setting = GUID::zeroed();
            assert_eq!(read(&notification), None);
        }

        #[test]
        fn retries_failed_updates_and_stops_touching_destroyed_controllers() {
            let attempts = Rc::new(Cell::new(0));
            let calls = attempts.clone();
            let state = state(move |_| {
                calls.set(calls.get() + 1);
                if calls.get() == 1 {
                    Err(Error::from_hresult(HRESULT(0x80004005u32 as i32)))
                } else {
                    Ok(())
                }
            });
            state.apply(true);
            state.apply(true);
            state.apply(true);
            assert_eq!(attempts.get(), 2);
            state.apply(false);
            assert_eq!(attempts.get(), 3);
            state.destroyed.set(true);
            state.apply(true);
            assert_eq!(attempts.get(), 3);
        }

        #[test]
        fn nested_messages_do_not_repeat_an_in_progress_controller_update() {
            let owner = Rc::new(RefCell::new(std::rc::Weak::<WindowVisibility>::new()));
            let nested_owner = owner.clone();
            let calls = Rc::new(Cell::new(0));
            let nested_calls = calls.clone();
            let state = Rc::new(state(move |visible| {
                nested_calls.set(nested_calls.get() + 1);
                assert_eq!(nested_calls.get(), 1);
                nested_owner.borrow().upgrade().unwrap().apply(visible);
                Ok(())
            }));
            *owner.borrow_mut() = Rc::downgrade(&state);
            state.apply(true);
            assert_eq!(calls.get(), 1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::DisplayVisibility;

    #[test]
    fn display_sleep_and_wake_preserve_hidden_and_minimized_windows() {
        let mut display = DisplayVisibility::default();
        assert!(display.should_render(true, false));
        display.power_changed(0);
        assert!(!display.should_render(true, false));
        assert!(!display.should_render(false, false));
        assert!(!display.should_render(true, true));

        display.power_changed(1);
        assert!(display.should_render(true, false));
        assert!(!display.should_render(false, false));
        assert!(!display.should_render(true, true));
    }

    #[test]
    fn restoring_or_showing_a_window_does_not_override_display_sleep() {
        let mut display = DisplayVisibility::default();
        display.power_changed(0);
        for (visible, minimized) in [(false, false), (true, true), (true, false)] {
            assert!(!display.should_render(visible, minimized));
        }
        display.power_changed(1);
        assert!(display.should_render(true, false));
    }

    #[test]
    fn dimming_and_unknown_power_values_do_not_blank_the_window() {
        let mut display = DisplayVisibility::default();
        display.power_changed(2);
        assert!(display.should_render(true, false));
        display.power_changed(u32::MAX);
        assert!(display.should_render(true, false));
        display.power_changed(0);
        display.power_changed(u32::MAX);
        assert!(!display.should_render(true, false));
        display.power_changed(2);
        assert!(display.should_render(true, false));
    }
}
