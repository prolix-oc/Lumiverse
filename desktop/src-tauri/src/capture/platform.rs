use std::sync::{atomic::AtomicBool, Arc};
use tauri::AppHandle;
use tokio::sync::oneshot;

#[cfg(not(target_os = "windows"))]
use super::Capabilities;
use super::{CaptureRequest, Media};

pub fn displays() -> Vec<super::displays::NativeDisplay> {
    #[cfg(target_os = "windows")]
    { return super::windows::displays(); }
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn lumiverse_capture_displays(callback: extern "C" fn(*const u8, usize, *mut std::ffi::c_void), context: *mut std::ffi::c_void);
        }
        extern "C" fn receive(bytes: *const u8, count: usize, context: *mut std::ffi::c_void) {
            if bytes.is_null() || count > 32768 { return; }
            let result = unsafe { &mut *(context as *mut Vec<super::displays::NativeDisplay>) };
            *result = serde_json::from_slice(unsafe { std::slice::from_raw_parts(bytes, count) }).unwrap_or_default();
        }
        let mut result = Vec::new();
        unsafe { lumiverse_capture_displays(receive, &mut result as *mut _ as *mut std::ffi::c_void); }
        return result;
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    { Vec::new() }
}

pub fn forget_sources() {
    #[cfg(target_os = "windows")]
    super::windows::forget_sources();
}

pub fn source_status(source: &str) -> &'static str {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn lumiverse_capture_source_status(source: *const std::ffi::c_char) -> u32;
        }
        let Ok(source) = std::ffi::CString::new(source) else {
            return "missing";
        };
        return match unsafe { lumiverse_capture_source_status(source.as_ptr()) } {
            1 => "ready",
            2 => "permission_required",
            _ => "missing",
        };
    }
    #[cfg(target_os = "windows")]
    {
        return super::windows::source_status(source);
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = source;
        "unknown"
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::{
        ffi::{c_char, c_void, CString},
        slice,
        sync::atomic::Ordering,
    };

    type Sender = oneshot::Sender<Result<Media, &'static str>>;

    struct Completion {
        sender: Sender,
        active: Arc<AtomicBool>,
        consent: super::super::consent::Context,
    }

    extern "C" {
        fn lumiverse_capture_capabilities() -> u32;
        fn lumiverse_capture_begin(
            request_id: *const c_char,
            consent: *const c_char,
            summary: *const c_char,
            source: *const c_char,
            display: *const c_char,
            can_remember: bool,
            invalidate: extern "C" fn(*mut c_void),
            remember: extern "C" fn(*mut c_void, *const c_char),
            video: bool,
            seconds: u64,
            max_bytes: usize,
            max_pixels: u64,
            remaining_ms: u64,
            callback: extern "C" fn(
                *mut c_void,
                u32,
                *const u8,
                usize,
                u32,
                u32,
                f64,
                *const c_char,
            ),
            context: *mut c_void,
        );
        fn lumiverse_capture_cancel(request_id: *const c_char);
        fn lumiverse_capture_finish(request_id: *const c_char);
        fn lumiverse_capture_shutdown();
    }

    pub fn capabilities() -> Capabilities {
        let flags = unsafe { lumiverse_capture_capabilities() };
        Capabilities {
            image: flags & 1 != 0,
            video: flags & 2 != 0,
            replay: false,
        }
    }

    extern "C" fn invalidate(context: *mut c_void) {
        let completion = unsafe { &*(context as *const Completion) };
        completion.consent.invalidate();
    }

    extern "C" fn remember(context: *mut c_void, source: *const c_char) {
        let completion = unsafe { &*(context as *const Completion) };
        if completion.active.load(Ordering::SeqCst) && !source.is_null() {
            let source = unsafe { std::ffi::CStr::from_ptr(source) }
                .to_string_lossy()
                .into_owned();
            completion.consent.remember(source);
        }
    }

    extern "C" fn complete(
        context: *mut c_void,
        outcome: u32,
        bytes: *const u8,
        count: usize,
        width: u32,
        height: u32,
        duration: f64,
        source: *const c_char,
    ) {
        let completion = unsafe { Box::from_raw(context as *mut Completion) };
        let result = match outcome {
            0 if completion.active.load(Ordering::SeqCst)
                && !bytes.is_null()
                && count > 0
                && count <= super::super::VIDEO_BYTES =>
            {
                if !source.is_null() {
                    let source = unsafe { std::ffi::CStr::from_ptr(source) }
                        .to_string_lossy()
                        .into_owned();
                    completion.consent.remember(source);
                }
                Ok(Media {
                    bytes: unsafe { slice::from_raw_parts(bytes, count) }.to_vec(),
                    width,
                    height,
                    duration_seconds: if duration > 0.0 { Some(duration) } else { None },
                })
            }
            1 => Err("denied"),
            2 | 5 => Err("cancelled"),
            3 => Err("unsupported"),
            _ => Err("failed"),
        };
        let _ = completion.sender.send(result);
    }

    pub fn begin(
        app: &AppHandle,
        request: &CaptureRequest,
        origin: &str,
        account: &str,
        approval: super::super::consent::Context,
        active: Arc<AtomicBool>,
    ) -> oneshot::Receiver<Result<Media, &'static str>> {
        let (sender, receiver) = oneshot::channel();
        let source = match approval.source() {
            Ok(source) => source,
            Err(error) => {
                let _ = sender.send(Err(error));
                return receiver;
            }
        };
        let can_remember = approval.can_remember;
        let request = request.clone();
        let consent = request.consent_text(origin, account);
        let summary = request.consent_summary(origin, account);
        let context = Box::into_raw(Box::new(Completion {
            sender,
            active: active.clone(),
            consent: approval,
        })) as usize;
        if app
            .run_on_main_thread(move || {
                if !active.load(Ordering::SeqCst) || request.expires_at <= super::super::now_ms() {
                    let completion = unsafe { Box::from_raw(context as *mut Completion) };
                    let _ = completion.sender.send(Err("cancelled"));
                    return;
                }
                let request_id = CString::new(request.request_id).unwrap();
                let consent = CString::new(consent).unwrap();
                let summary = CString::new(summary).unwrap();
                let source = source.and_then(|source| CString::new(source).ok());
                let display = request.display.as_ref().and_then(|display| CString::new(display.identity.as_str()).ok());
                unsafe {
                    lumiverse_capture_begin(
                        request_id.as_ptr(),
                        consent.as_ptr(),
                        summary.as_ptr(),
                        source
                            .as_ref()
                            .map_or(std::ptr::null(), |source| source.as_ptr()),
                        display.as_ref().map_or(std::ptr::null(), |display| display.as_ptr()),
                        can_remember,
                        invalidate,
                        remember,
                        request.kind == "video",
                        request.duration_seconds.unwrap_or_default(),
                        request.max_bytes,
                        request.max_pixels,
                        request.expires_at.saturating_sub(super::super::now_ms()),
                        complete,
                        context as *mut c_void,
                    );
                }
            })
            .is_err()
        {
            let completion = unsafe { Box::from_raw(context as *mut Completion) };
            let _ = completion.sender.send(Err("failed"));
        }
        receiver
    }

    pub fn cancel(app: &AppHandle, request_id: &str) {
        if let Ok(request_id) = CString::new(request_id) {
            let _ = app.run_on_main_thread(move || unsafe {
                lumiverse_capture_cancel(request_id.as_ptr())
            });
        }
    }

    pub fn finish(app: &AppHandle, request_id: &str) {
        if let Ok(request_id) = CString::new(request_id) {
            let _ = app.run_on_main_thread(move || unsafe {
                lumiverse_capture_finish(request_id.as_ptr())
            });
        }
    }

    pub fn shutdown() {
        unsafe { lumiverse_capture_shutdown() };
    }
}

#[cfg(target_os = "macos")]
pub use macos::{begin, cancel, capabilities, finish, shutdown};

#[cfg(target_os = "windows")]
pub use super::windows::{capabilities, shutdown};

#[cfg(target_os = "windows")]
pub fn begin(
    _: &AppHandle,
    request: &CaptureRequest,
    origin: &str,
    account: &str,
    approval: super::consent::Context,
    active: Arc<AtomicBool>,
) -> oneshot::Receiver<Result<Media, &'static str>> {
    super::windows::begin(
        request,
        request.consent_text(origin, account),
        request.consent_summary(origin, account),
        approval,
        active,
    )
}

#[cfg(target_os = "windows")]
pub fn cancel(_: &AppHandle, request_id: &str) {
    super::windows::cancel(request_id);
}

#[cfg(target_os = "windows")]
pub fn finish(_: &AppHandle, request_id: &str) {
    super::windows::finish(request_id);
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn capabilities() -> Capabilities {
    Capabilities {
        image: false,
        video: false,
        replay: false,
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn begin(
    _: &AppHandle,
    _: &CaptureRequest,
    _: &str,
    _: &str,
    _: super::consent::Context,
    _: Arc<AtomicBool>,
) -> oneshot::Receiver<Result<Media, &'static str>> {
    let (sender, receiver) = oneshot::channel();
    let _ = sender.send(Err("unsupported"));
    receiver
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn cancel(_: &AppHandle, _: &str) {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn finish(_: &AppHandle, _: &str) {}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn shutdown() {}
