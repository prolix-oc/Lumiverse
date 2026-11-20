use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::{self, Write},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};
use tokio::sync::oneshot;
use windows::{
    core::{w, AgileReference, Error, Interface, Result, HSTRING, PCWSTR},
    Foundation::Metadata::ApiInformation,
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{
            Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCapturePicker,
            GraphicsCaptureSession,
        },
        DirectX::{
            Direct3D11::{IDirect3DDevice, IDirect3DSurface},
            DirectXPixelFormat,
        },
    },
    Media::{
        Core::{
            MediaSource, MediaStreamSample, MediaStreamSource, MediaStreamSourceSampleRequest,
            MediaStreamSourceSampleRequestDeferral, VideoStreamDescriptor,
        },
        MediaProperties::{
            AudioEncodingProperties, MediaEncodingProfile, MediaEncodingSubtypes,
            VideoEncodingProperties, VideoEncodingQuality,
        },
        Playback::{MediaPlaybackItem, MediaPlayer},
        Transcoding::MediaTranscoder,
    },
    Storage::Streams::{DataReader, InMemoryRandomAccessStream},
    Win32::{
        Foundation::{E_FAIL, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::{
            Gdi::{
                EnumDisplayDevicesW, EnumDisplayMonitors, GetMonitorInfoW, DISPLAY_DEVICEW, HDC,
                HMONITOR, MONITORINFO, MONITORINFOEXW,
            },
            Direct3D::D3D_DRIVER_TYPE_HARDWARE,
            Direct3D11::*,
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                IDXGIDevice,
            },
        },
        System::{
            LibraryLoader::GetModuleHandleW,
            RemoteDesktop::*,
            WinRT::{
                CreateDispatcherQueueController,
                Direct3D11::{
                    CreateDirect3D11DeviceFromDXGIDevice, CreateDirect3D11SurfaceFromDXGISurface,
                    IDirect3DDxgiInterfaceAccess,
                },
                DispatcherQueueOptions, RoInitialize, RoUninitialize, DQTAT_COM_STA,
                DQTYPE_THREAD_CURRENT, RO_INIT_MULTITHREADED, RO_INIT_SINGLETHREADED,
            },
        },
        UI::{Shell::IInitializeWithWindow, WindowsAndMessaging::*},
    },
};
use windows_future::{
    AsyncActionWithProgressCompletedHandler, AsyncOperationCompletedHandler, AsyncStatus,
    IAsyncActionWithProgress, IAsyncOperation,
};

use super::{Capabilities, CaptureRequest, Media};
mod display;
use display::{DisplayCapture, DpiAwareness};

const EVENT_MESSAGE: u32 = WM_APP + 71;
const FRAME_TICKS: i64 = 10_000_000 / 30;

fn recording_end_ticks(seconds: u64, elapsed: i64, last_sample: i64) -> i64 {
    elapsed.max(last_sample.saturating_add(FRAME_TICKS)).clamp(FRAME_TICKS, seconds as i64 * 10_000_000)
}

struct Control {
    request_id: String,
    finish_requested: AtomicBool,
    active: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    window: AtomicUsize,
}

fn current() -> &'static Mutex<Option<Arc<Control>>> {
    static CURRENT: OnceLock<Mutex<Option<Arc<Control>>>> = OnceLock::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

struct Apartment;

impl Apartment {
    fn new(kind: windows::Win32::System::WinRT::RO_INIT_TYPE) -> Result<Self> {
        unsafe {
            RoInitialize(kind)?;
        }
        Ok(Self)
    }
}

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

pub fn capabilities() -> Capabilities {
    static CAPABILITIES: OnceLock<Capabilities> = OnceLock::new();
    *CAPABILITIES.get_or_init(|| {
        std::thread::spawn(|| {
            let Ok(_apartment) = Apartment::new(RO_INIT_MULTITHREADED) else {
                return unsupported();
            };
            let supported = ApiInformation::IsApiContractPresentByMajor(
                &HSTRING::from("Windows.Foundation.UniversalApiContract"),
                8,
            )
            .unwrap_or(false)
                && GraphicsCaptureSession::IsSupported().unwrap_or(false)
                && Gpu::new().is_ok();
            Capabilities {
                image: supported,
                video: supported
                    && MediaTranscoder::new().is_ok()
                    && MediaEncodingProfile::CreateMp4(VideoEncodingQuality::HD1080p).is_ok(),
                replay: false,
            }
        })
        .join()
        .unwrap_or_else(|_| unsupported())
    })
}

fn unsupported() -> Capabilities {
    Capabilities {
        image: false,
        video: false,
        replay: false,
    }
}

fn monitor_info(monitor: HMONITOR) -> Option<(super::displays::NativeDisplay, windows::Win32::Foundation::RECT)> {
    unsafe {
        let mut info = MONITORINFOEXW::default();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if !GetMonitorInfoW(monitor, &mut info as *mut _ as *mut MONITORINFO).as_bool() {
            return None;
        }
        let text = |value: &[u16]| {
            String::from_utf16_lossy(
                &value[..value.iter().position(|value| *value == 0).unwrap_or(value.len())],
            )
        };
        let device_name = text(&info.szDevice);
        let mut device = DISPLAY_DEVICEW {
            cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32,
            ..Default::default()
        };
        // Include the monitor interface identity so a different panel on the same output
        // cannot inherit this display's saved approval.
        if !EnumDisplayDevicesW(
            PCWSTR(info.szDevice.as_ptr()), 0, &mut device, EDD_GET_DEVICE_INTERFACE_NAME,
        ).as_bool() {
            return None;
        }
        let identity = serde_json::to_string(&(&device_name, text(&device.DeviceID))).unwrap();
        let rect = info.monitorInfo.rcMonitor;
        if rect.right > rect.left && rect.bottom > rect.top {
            return Some((
                super::displays::NativeDisplay {
                    identity,
                    name: format!("Display {}", device_name.trim_start_matches(r"\\.\DISPLAY")),
                    width: (rect.right - rect.left) as u32,
                    height: (rect.bottom - rect.top) as u32,
                    primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
                },
                rect,
            ));
        }
        None
    }
}

// Enumerate monitor metadata without opening a capture session or an OS picker.
fn display_monitors() -> Vec<(super::displays::NativeDisplay, HMONITOR)> {
    let Ok(_dpi) = DpiAwareness::enter() else {
        return Vec::new();
    };
    unsafe extern "system" fn visit(
        monitor: HMONITOR,
        _: HDC,
        _: *mut windows::Win32::Foundation::RECT,
        context: LPARAM,
    ) -> windows::core::BOOL {
        let result = &mut *(context.0 as *mut Vec<(super::displays::NativeDisplay, HMONITOR)>);
        if let Some((display, _)) = monitor_info(monitor) {
            result.push((display, monitor));
        }
        true.into()
    }
    let mut result: Vec<(super::displays::NativeDisplay, HMONITOR)> = Vec::new();
    if !unsafe {
        EnumDisplayMonitors(None, None, Some(visit), LPARAM(&mut result as *mut _ as isize))
    }.as_bool() {
        result.clear();
    }
    result.sort_by(|a, b| a.0.name.cmp(&b.0.name));
    result
}

pub fn displays() -> Vec<super::displays::NativeDisplay> {
    display_monitors()
        .into_iter()
        .map(|(display, _)| display)
        .collect()
}

// Keep OS-selected capture items native. Tokens never reach the extension or survive this process.
struct RememberedItem {
    item: AgileReference<GraphicsCaptureItem>,
    closed: Arc<AtomicBool>,
}
fn sources() -> &'static Mutex<BTreeMap<String, RememberedItem>> {
    static SOURCES: OnceLock<Mutex<BTreeMap<String, RememberedItem>>> = OnceLock::new();
    SOURCES.get_or_init(|| Mutex::new(BTreeMap::new()))
}

pub fn forget_sources() {
    if let Ok(mut sources) = sources().lock() {
        sources.clear();
    }
}

pub fn source_status(source: &str) -> &'static str {
    if sources().lock().is_ok_and(|sources| {
        sources
            .get(source)
            .is_some_and(|item| !item.closed.load(Ordering::SeqCst))
    }) {
        "ready"
    } else {
        "missing"
    }
}

pub fn begin(
    request: &CaptureRequest,
    _consent: String,
    _summary: String,
    approval: super::consent::Context,
    active: Arc<AtomicBool>,
) -> oneshot::Receiver<std::result::Result<Media, &'static str>> {
    let (sender, receiver) = oneshot::channel();
    let saved_source = match approval.source() {
        Ok(source) => source,
        Err(error) => {
            let _ = sender.send(Err(error));
            return receiver;
        }
    };
    let control = Arc::new(Control {
        request_id: request.request_id.clone(),
        finish_requested: AtomicBool::new(false),
        active,
        alive: Arc::new(AtomicBool::new(true)),
        window: AtomicUsize::new(0),
    });
    {
        let mut guard = current().lock().unwrap();
        if guard.is_some() {
            let _ = sender.send(Err("failed"));
            return receiver;
        }
        *guard = Some(control.clone());
    }
    let request = request.clone();
    let thread_control = control.clone();
    let launched = std::thread::Builder::new()
        .name("lumiverse-windows-capture".into())
        .spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                run(
                    request,
                    approval,
                    saved_source,
                    thread_control.clone(),
                )
            }))
            .unwrap_or(Err("failed"));
            let result = if !thread_control.active.load(Ordering::SeqCst) {
                Err("cancelled")
            } else {
                result
            };
            thread_control.active.store(false, Ordering::SeqCst);
            let mut guard = current().lock().unwrap();
            if guard
                .as_ref()
                .is_some_and(|present| Arc::ptr_eq(present, &thread_control))
            {
                *guard = None;
            }
            drop(guard);
            let _ = sender.send(result);
        });
    if launched.is_err() {
        control.active.store(false, Ordering::SeqCst);
        control.alive.store(false, Ordering::SeqCst);
        *current().lock().unwrap() = None;
    }
    receiver
}

pub fn finish(request_id: &str) {
    if let Some(control) = current().lock().unwrap().as_ref().filter(|control| control.request_id == request_id) {
        // Finalization preserves active; cancellation always wins over this flag.
        control.finish_requested.store(true, Ordering::SeqCst);
    }
}

pub fn cancel(request_id: &str) {
    if let Some(control) = current()
        .lock()
        .unwrap()
        .as_ref()
        .filter(|control| control.request_id == request_id)
    {
        stop(control);
    }
}

fn stop(control: &Control) {
    control.active.store(false, Ordering::SeqCst);
    let address = control.window.load(Ordering::SeqCst);
    if address != 0 {
        unsafe {
            let _ = PostMessageW(Some(HWND(address as _)), WM_CLOSE, WPARAM(0), LPARAM(0));
        }
    }
}

pub fn shutdown() {
    if let Some(control) = current().lock().unwrap().as_ref() {
        stop(control);
    }
}

#[derive(Clone)]
struct Gpu {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    projected: AgileReference<IDirect3DDevice>,
}

impl Gpu {
    fn new() -> Result<Self> {
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?;
        }
        let device = device.ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let context = context.ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let multithread: ID3D11Multithread = context.cast()?;
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
        let dxgi: IDXGIDevice = device.cast()?;
        let projected: IDirect3DDevice =
            unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()? };
        let projected = AgileReference::new(&projected)?;
        Ok(Self {
            device,
            context,
            projected,
        })
    }

    fn texture(&self, width: u32, height: u32, staging: bool) -> Result<ID3D11Texture2D> {
        let description = D3D11_TEXTURE2D_DESC {
            Width: width,
            Height: height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0,
            },
            Usage: if staging {
                D3D11_USAGE_STAGING
            } else {
                D3D11_USAGE_DEFAULT
            },
            BindFlags: if staging {
                0
            } else {
                (D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET).0 as u32
            },
            CPUAccessFlags: if staging {
                D3D11_CPU_ACCESS_READ.0 as u32
            } else {
                0
            },
            ..Default::default()
        };
        let mut texture = None;
        unsafe {
            self.device
                .CreateTexture2D(&description, None, Some(&mut texture))?;
        }
        texture.ok_or_else(|| Error::from_hresult(E_FAIL))
    }

    fn surface(&self, texture: &ID3D11Texture2D) -> Result<IDirect3DSurface> {
        let dxgi: windows::Win32::Graphics::Dxgi::IDXGISurface = texture.cast()?;
        unsafe { CreateDirect3D11SurfaceFromDXGISurface(&dxgi)?.cast() }
    }

    fn copy(
        &self,
        surface: &IDirect3DSurface,
        width: u32,
        height: u32,
    ) -> Result<IDirect3DSurface> {
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let source: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let mut description = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            source.GetDesc(&mut description);
        }
        if description.Width < width
            || description.Height < height
            || description.Format != DXGI_FORMAT_B8G8R8A8_UNORM
        {
            return Err(Error::from_hresult(E_FAIL));
        }
        let target = self.texture(width, height, false)?;
        let region = D3D11_BOX {
            left: 0,
            top: 0,
            front: 0,
            right: width,
            bottom: height,
            back: 1,
        };
        unsafe {
            self.context
                .CopySubresourceRegion(&target, 0, 0, 0, 0, &source, 0, Some(&region));
        }
        self.surface(&target)
    }

    fn pixels(&self, surface: &IDirect3DSurface, width: u32, height: u32) -> Result<Pixels> {
        let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
        let source: ID3D11Texture2D = unsafe { access.GetInterface()? };
        let staging = self.texture(width, height, true)?;
        unsafe {
            self.context.CopyResource(&staging, &source);
        }
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        }
        let stride = width as usize * 4;
        if mapped.pData.is_null() || (mapped.RowPitch as usize) < stride {
            unsafe {
                self.context.Unmap(&staging, 0);
            }
            return Err(Error::from_hresult(E_FAIL));
        }
        let mut bytes = vec![0; stride * height as usize];
        for row in 0..height as usize {
            unsafe {
                std::ptr::copy_nonoverlapping(
                    (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                    bytes.as_mut_ptr().add(row * stride),
                    stride,
                );
            }
        }
        unsafe {
            self.context.Unmap(&staging, 0);
        }
        Ok(Pixels {
            bytes,
            width,
            height,
        })
    }
}

struct Pixels {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}
impl Drop for Pixels {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

struct LimitedWriter {
    bytes: Vec<u8>,
    maximum: usize,
    active: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
}
impl Write for LimitedWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        if !self.active.load(Ordering::SeqCst)
            || !self.alive.load(Ordering::SeqCst)
            || data.len() > self.maximum.saturating_sub(self.bytes.len())
        {
            return Err(io::Error::other("capture cancelled or byte limit exceeded"));
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
impl Drop for LimitedWriter {
    fn drop(&mut self) {
        self.bytes.fill(0);
    }
}

struct SampleRequest {
    request: MediaStreamSourceSampleRequest,
    deferral: MediaStreamSourceSampleRequestDeferral,
    completed: bool,
}

impl SampleRequest {
    fn new(request: MediaStreamSourceSampleRequest) -> Result<Self> {
        let deferral = request.GetDeferral()?;
        Ok(Self {
            request,
            deferral,
            completed: false,
        })
    }

    fn respond(mut self, sample: Option<&MediaStreamSample>) -> Result<()> {
        let result = self.request.SetSample(sample);
        if result.is_err() {
            let _ = self.request.SetSample(None);
        }
        let completed = self.deferral.Complete();
        self.completed = completed.is_ok();
        result.and(completed)
    }
}

impl Drop for SampleRequest {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self.request.SetSample(None);
            let _ = self.deferral.Complete();
        }
    }
}

struct PreviewFrames {
    latest: Option<Pixels>,
    updated: Instant,
}

enum Event {
    Selected(std::result::Result<GraphicsCaptureItem, ()>),
    Prepared(std::result::Result<windows::Media::Transcoding::PrepareTranscodeResult, ()>),
    Sample(SampleRequest),
    Encoded(bool),
    Image(std::result::Result<Media, ()>),
    Opened,
    Read(bool),
    Closed,
    Failed,
}

#[derive(Clone)]
struct Events {
    sender: SyncSender<Event>,
    control: Arc<Control>,
}
impl Events {
    fn post(&self, event: Event) -> Result<()> {
        if !self.control.active.load(Ordering::SeqCst) || !self.control.alive.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        self.sender.try_send(event).map_err(|_| {
            stop(&self.control);
            Error::from_hresult(E_FAIL)
        })?;
        let address = self.control.window.load(Ordering::SeqCst);
        if address != 0 {
            unsafe {
                PostMessageW(
                    Some(HWND(address as _)),
                    EVENT_MESSAGE,
                    WPARAM(0),
                    LPARAM(0),
                )?;
            }
        }
        Ok(())
    }
}

#[derive(PartialEq)]
enum Phase {
    Consent,
    Picking,
    Recording,
    Finishing,
    Preview,
    Reading,
    Done,
}

struct Ui {
    request: CaptureRequest,
    approval: super::consent::Context,
    saved_source: Option<String>,
    remembering: bool,
    selected_source: Option<String>,
    control: Arc<Control>,
    events: Events,
    incoming: Receiver<Event>,
    phase: Phase,
    window: HWND,
    gpu: Option<Gpu>,
    item: Option<GraphicsCaptureItem>,
    closed_token: Option<i64>,
    pool: Option<Direct3D11CaptureFramePool>,
    display_capture: Option<DisplayCapture>,
    capture: Option<GraphicsCaptureSession>,
    source: Option<MediaStreamSource>,
    stream: Option<InMemoryRandomAccessStream>,
    transcoder: Option<MediaTranscoder>,
    prepare: Option<IAsyncOperation<windows::Media::Transcoding::PrepareTranscodeResult>>,
    transcode: Option<IAsyncActionWithProgress<f64>>,
    picker: Option<IAsyncOperation<GraphicsCaptureItem>>,
    pending_sample: Option<SampleRequest>,
    last_surface: Option<IDirect3DSurface>,
    source_width: u32,
    source_height: u32,
    width: u32,
    height: u32,
    start: Option<Instant>,
    last_sample: i64,
    final_sample: bool,
    end_ticks: Option<i64>,
    pixels: Option<Pixels>,
    media: Option<Media>,
    player: Option<MediaPlayer>,
    playback: Option<MediaPlaybackItem>,
    preview_surface: Option<IDirect3DSurface>,
    preview: Arc<Mutex<PreviewFrames>>,
    reader: Option<DataReader>,
    read: Option<IAsyncOperation<u32>>,
    result: Option<std::result::Result<Media, &'static str>>,
}

impl Ui {
    fn new(
        request: CaptureRequest,
        approval: super::consent::Context,
        saved_source: Option<String>,
        control: Arc<Control>,
    ) -> Self {
        let (sender, incoming) = mpsc::sync_channel(8);
        Self {
            request,
            approval,
            saved_source,
            remembering: false,
            selected_source: None,
            control: control.clone(),
            events: Events { sender, control },
            incoming,
            phase: Phase::Consent,
            window: HWND::default(),
            gpu: None,
            item: None,
            closed_token: None,
            pool: None,
            display_capture: None,
            capture: None,
            source: None,
            stream: None,
            transcoder: None,
            prepare: None,
            transcode: None,
            picker: None,
            pending_sample: None,
            last_surface: None,
            source_width: 0,
            source_height: 0,
            width: 0,
            height: 0,
            start: None,
            last_sample: -1,
            final_sample: false,
            end_ticks: None,
            pixels: None,
            media: None,
            player: None,
            playback: None,
            preview_surface: None,
            preview: Arc::new(Mutex::new(PreviewFrames {
                latest: None,
                updated: Instant::now(),
            })),
            reader: None,
            read: None,
            result: None,
        }
    }

    fn still_active(&self) -> bool {
        self.control.active.load(Ordering::SeqCst)
            && self.control.alive.load(Ordering::SeqCst)
            && self.request.expires_at > super::now_ms()
    }

    fn choose(&mut self) -> Result<()> {
        if self.phase != Phase::Consent {
            return Ok(());
        }
        if !self.still_active() {
            self.finish(Err("cancelled"));
            return Ok(());
        }
        self.remembering = self.approval.can_remember;
        self.phase = Phase::Picking;
        let picker = GraphicsCapturePicker::new()?;
        let initializer: IInitializeWithWindow = picker.cast()?;
        unsafe {
            initializer.Initialize(self.window)?;
        }
        let operation = picker.PickSingleItemAsync()?;
        let events = self.events.clone();
        operation.SetCompleted(&AsyncOperationCompletedHandler::new(
            move |operation, status| {
                let selected = if status == AsyncStatus::Completed {
                    operation
                        .as_ref()
                        .and_then(|operation| operation.GetResults().ok())
                        .ok_or(())
                } else {
                    Err(())
                };
                events.post(Event::Selected(selected))
            },
        ))?;
        self.picker = Some(operation);
        Ok(())
    }

    fn selected(&mut self, item: GraphicsCaptureItem) -> Result<()> {
        if !self.still_active() {
            self.finish(Err("cancelled"));
            return Ok(());
        }
        if self.remembering && self.selected_source.is_none() {
            let closed = Arc::new(AtomicBool::new(false));
            let closed_flag = closed.clone();
            item.Closed(&TypedEventHandler::new(move |_, _| {
                closed_flag.store(true, Ordering::SeqCst);
                Ok(())
            }))?;
            let token = uuid::Uuid::new_v4().to_string();
            let mut saved = sources().lock().unwrap();
            saved.retain(|_, value| !value.closed.load(Ordering::SeqCst));
            if saved.len() < 128 {
                saved.insert(
                    token.clone(),
                    RememberedItem {
                        item: AgileReference::new(&item)?,
                        closed,
                    },
                );
                self.selected_source = Some(token);
            }
        }
        let size = item.Size()?;
        if size.Width <= 0
            || size.Height <= 0
            || size.Width as u64 * size.Height as u64 > self.request.max_pixels
        {
            self.finish(Err("unsupported"));
            return Ok(());
        }
        // Choosing the OS item approves the source independently of this capture's outcome.
        if self.remembering {
            if let Some(source) = &self.selected_source {
                self.approval.remember(source.clone());
            }
        }
        self.source_width = size.Width as u32;
        self.source_height = size.Height as u32;
        (self.width, self.height) = output_size(self.source_width, self.source_height);
        let events = self.events.clone();
        self.closed_token = Some(item.Closed(&TypedEventHandler::new(move |_, _| {
            events.post(Event::Closed)
        }))?);
        let gpu = Gpu::new()?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &gpu.projected.resolve()?,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )?;
        let capture = pool.CreateCaptureSession(&item)?;
        self.item = Some(item);
        self.gpu = Some(gpu);
        self.pool = Some(pool);
        self.capture = Some(capture);
        if !self.still_active() {
            self.finish(Err("cancelled"));
            return Ok(());
        }
        if self.request.kind == "video" {
            self.start = Some(Instant::now());
        }
        self.capture
            .as_ref()
            .ok_or_else(|| Error::from_hresult(E_FAIL))?
            .StartCapture()?;
        self.phase = Phase::Recording;
        if self.request.kind == "video" {
            self.start_video()?;
        }
        Ok(())
    }

    fn selected_display(&mut self) -> Result<()> {
        if !self.still_active() || !self.approval.can_remember || self.approval.source().is_err() {
            self.finish(Err("denied"));
            return Ok(());
        }
        let display = self.request.display.as_ref()
            .ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let gpu = Gpu::new()?;
        let capture = DisplayCapture::new(display, self.request.max_pixels, &gpu)?;
        (self.source_width, self.source_height) = capture.size();
        (self.width, self.height) = output_size(self.source_width, self.source_height);
        self.gpu = Some(gpu);
        self.display_capture = Some(capture);
        if self.request.kind == "video" {
            self.start = Some(Instant::now());
        }
        self.phase = Phase::Recording;
        if self.request.kind == "video" {
            self.start_video()?;
        }
        Ok(())
    }

    fn start_video(&mut self) -> Result<()> {
        let properties = VideoEncodingProperties::CreateUncompressed(
            &MediaEncodingSubtypes::Bgra8()?,
            self.source_width,
            self.source_height,
        )?;
        let descriptor = VideoStreamDescriptor::Create(&properties)?;
        let source = MediaStreamSource::CreateFromDescriptor(&descriptor)?;
        source.SetBufferTime(TimeSpan { Duration: 0 })?;
        source.SetDuration(TimeSpan {
            Duration: self.request.duration_seconds.unwrap_or_default() as i64 * 10_000_000,
        })?;
        source.Starting(&TypedEventHandler::new(
            move |_,
                  args: windows::core::Ref<
                '_,
                windows::Media::Core::MediaStreamSourceStartingEventArgs,
            >| {
                if let Some(args) = args.as_ref() {
                    args.Request()?
                        .SetActualStartPosition(TimeSpan { Duration: 0 })?;
                }
                Ok(())
            },
        ))?;
        let events = self.events.clone();
        source.SampleRequested(&TypedEventHandler::new(
            move |_,
                  args: windows::core::Ref<
                '_,
                windows::Media::Core::MediaStreamSourceSampleRequestedEventArgs,
            >| {
                if let Some(args) = args.as_ref() {
                    events.post(Event::Sample(SampleRequest::new(args.Request()?)?))?;
                }
                Ok(())
            },
        ))?;
        let profile = MediaEncodingProfile::CreateMp4(VideoEncodingQuality::HD1080p)?;
        profile.SetAudio(None::<&AudioEncodingProperties>)?;
        let output = profile.Video()?;
        output.SetWidth(self.width)?;
        output.SetHeight(self.height)?;
        output.SetBitrate(8_000_000)?;
        output.FrameRate()?.SetNumerator(30)?;
        output.FrameRate()?.SetDenominator(1)?;
        let stream = InMemoryRandomAccessStream::new()?;
        let transcoder = MediaTranscoder::new()?;
        transcoder.SetHardwareAccelerationEnabled(true)?;
        let operation =
            transcoder.PrepareMediaStreamSourceTranscodeAsync(&source, &stream, &profile)?;
        let events = self.events.clone();
        operation.SetCompleted(&AsyncOperationCompletedHandler::new(
            move |operation, status| {
                let prepared = if status == AsyncStatus::Completed {
                    operation
                        .as_ref()
                        .and_then(|operation| operation.GetResults().ok())
                        .ok_or(())
                } else {
                    Err(())
                };
                events.post(Event::Prepared(prepared))
            },
        ))?;
        self.source = Some(source);
        self.stream = Some(stream);
        self.transcoder = Some(transcoder);
        self.prepare = Some(operation);
        Ok(())
    }

    fn frame(&mut self) -> Result<()> {
        if let Some(capture) = &self.display_capture {
            let gpu = self.gpu.as_ref().ok_or_else(|| Error::from_hresult(E_FAIL))?;
            self.last_surface = Some(capture.frame(gpu)?);
        } else if let Some(pool) = &self.pool {
            for _attempt in 0..2 {
                let frame = match pool.TryGetNextFrame() {
                    Ok(frame) => frame,
                    Err(_) => break,
                };
                let size = frame.ContentSize()?;
                if size.Width != self.source_width as i32 || size.Height != self.source_height as i32 {
                    let _ = frame.Close();
                    self.finish(Err("cancelled"));
                    return Ok(());
                }
                let surface = self
                    .gpu
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?
                    .copy(&frame.Surface()?, self.source_width, self.source_height)?;
                frame.Close()?;
                self.last_surface = Some(surface);
            }
        } else {
            return Ok(());
        }
        if self.request.kind == "image" && self.last_surface.is_some() {
            self.close_capture();
            let pixels = self
                .gpu
                .as_ref()
                .ok_or_else(|| Error::from_hresult(E_FAIL))?
                .pixels(
                    self.last_surface
                        .as_ref()
                        .ok_or_else(|| Error::from_hresult(E_FAIL))?,
                    self.source_width,
                    self.source_height,
                )?;
            self.width = pixels.width;
            self.height = pixels.height;
            let mut copy = Pixels {
                bytes: pixels.bytes.clone(),
                width: pixels.width,
                height: pixels.height,
            };
            self.pixels = Some(pixels);
            self.phase = Phase::Finishing;
            let events = self.events.clone();
            let maximum = self.request.max_bytes;
            let active = self.control.active.clone();
            let alive = self.control.alive.clone();
            std::thread::Builder::new()
                .name("lumiverse-screenshot-encoder".into())
                .spawn(move || {
                    for pixel in copy.bytes.chunks_exact_mut(4) {
                        pixel.swap(0, 2);
                        pixel[3] = 255;
                    }
                    let mut writer = LimitedWriter {
                        bytes: Vec::new(),
                        maximum,
                        active,
                        alive,
                    };
                    let encoded = PngEncoder::new(&mut writer).write_image(
                        &copy.bytes,
                        copy.width,
                        copy.height,
                        ExtendedColorType::Rgba8,
                    );
                    let result = encoded
                        .map(|_| Media {
                            bytes: std::mem::take(&mut writer.bytes),
                            width: copy.width,
                            height: copy.height,
                            duration_seconds: None,
                        })
                        .map_err(|_| ());
                    let _ = events.post(Event::Image(result));
                })
                .map_err(|_| Error::from_hresult(E_FAIL))?;
        }
        Ok(())
    }

    fn sample(&mut self) -> Result<()> {
        if self.pending_sample.is_none() {
            return Ok(());
        }
        if self.last_surface.is_none() {
            if self.phase == Phase::Finishing {
                self.pending_sample
                    .take()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?
                    .respond(None)?;
            }
            return Ok(());
        }
        let start = self.start.ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let maximum = self.end_ticks.unwrap_or(self.request.duration_seconds.unwrap_or_default() as i64 * 10_000_000);
        let elapsed = (start.elapsed().as_nanos() / 100) as i64;
        if elapsed >= maximum {
            self.phase = Phase::Finishing;
            self.close_capture();
        }
        let timestamp = if self.phase == Phase::Finishing {
            maximum.saturating_sub(FRAME_TICKS)
        } else {
            elapsed
        };
        if self.phase == Phase::Finishing && (self.final_sample || timestamp <= self.last_sample) {
            self.pending_sample
                .take()
                .ok_or_else(|| Error::from_hresult(E_FAIL))?
                .respond(None)?;
            return Ok(());
        }
        if timestamp <= self.last_sample {
            return Ok(());
        }
        let request = self
            .pending_sample
            .take()
            .ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let surface = self
            .last_surface
            .as_ref()
            .ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let sample = MediaStreamSample::CreateFromDirect3D11Surface(
            surface,
            TimeSpan {
                Duration: timestamp,
            },
        )?;
        sample.SetDuration(TimeSpan {
            Duration: FRAME_TICKS.min(maximum.saturating_sub(timestamp)),
        })?;
        request.respond(Some(&sample))?;
        self.last_sample = timestamp;
        if self.phase == Phase::Finishing {
            self.final_sample = true;
        }
        Ok(())
    }

    fn tick(&mut self) -> Result<()> {
        if !self.control.active.load(Ordering::SeqCst) || self.request.expires_at <= super::now_ms()
        {
            self.finish(Err("cancelled"));
            return Ok(());
        }
        while let Ok(event) = self.incoming.try_recv() {
            self.handle(event)?;
            if self.phase == Phase::Done {
                return Ok(());
            }
        }
        if let Some(stream) = &self.stream {
            if stream.Size()? > self.request.max_bytes as u64 {
                self.finish(Err("failed"));
                return Ok(());
            }
        }
        if self.phase == Phase::Recording && self.request.kind == "video"
            && self.control.finish_requested.load(Ordering::SeqCst) && self.last_surface.is_some()
            && self.start.is_some_and(|start| start.elapsed().as_nanos() / 100 >= FRAME_TICKS as u128)
        {
            let elapsed = (self.start.unwrap().elapsed().as_nanos() / 100) as i64;
            self.end_ticks = Some(recording_end_ticks(self.request.duration_seconds.unwrap_or_default(), elapsed, self.last_sample));
            if let Some(source) = &self.source {
                source.SetDuration(TimeSpan { Duration: self.end_ticks.unwrap() })?;
            }
            self.phase = Phase::Finishing;
            self.close_capture();
        }
        if self.phase == Phase::Recording
            && self.request.kind == "video"
            && self.start.is_some_and(|start| {
                start.elapsed()
                    >= Duration::from_secs(self.request.duration_seconds.unwrap_or_default())
            })
        {
            self.phase = Phase::Finishing;
            self.close_capture();
        }
        if self.phase == Phase::Recording {
            self.frame()?;
            if self.phase == Phase::Done {
                return Ok(());
            }
            if self.request.kind == "video" {
                self.sample()?;
            }
        } else if self.phase == Phase::Finishing && self.request.kind == "video" {
            self.sample()?;
        }
        let preview = if self.phase == Phase::Preview {
            self.preview
                .try_lock()
                .ok()
                .and_then(|mut frames| frames.latest.take())
        } else {
            None
        };
        if let Some(pixels) = preview {
            let first = self.pixels.is_none();
            self.pixels = Some(pixels);
            if first {
                self.review()?;
            }
        }
        Ok(())
    }

    fn handle(&mut self, event: Event) -> Result<()> {
        if !self.still_active() {
            self.finish(Err("cancelled"));
            return Ok(());
        }
        match event {
            Event::Selected(Ok(item)) => self.selected(item)?,
            Event::Selected(Err(_)) | Event::Closed => self.finish(Err("cancelled")),
            Event::Prepared(Ok(prepared)) => {
                if !prepared.CanTranscode()? {
                    self.finish(Err("unsupported"));
                    return Ok(());
                }
                let operation = prepared.TranscodeAsync()?;
                let events = self.events.clone();
                operation.SetCompleted(&AsyncActionWithProgressCompletedHandler::new(
                    move |_, status| events.post(Event::Encoded(status == AsyncStatus::Completed)),
                ))?;
                self.transcode = Some(operation);
            }
            Event::Sample(request) => {
                if self.pending_sample.is_some() {
                    self.finish(Err("failed"));
                } else {
                    self.pending_sample = Some(request);
                }
            }
            Event::Encoded(true) => {
                self.close_capture();
                let stream = self
                    .stream
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?;
                if stream.Size()? == 0 || stream.Size()? > self.request.max_bytes as u64 {
                    self.finish(Err("failed"));
                    return Ok(());
                }
                stream.Seek(0)?;
                let source = MediaSource::CreateFromStream(stream, &HSTRING::from("video/mp4"))?;
                let playback = MediaPlaybackItem::Create(&source)?;
                let player = MediaPlayer::new()?;
                player.SetIsVideoFrameServerEnabled(true)?;
                let events = self.events.clone();
                player.MediaOpened(&TypedEventHandler::new(move |_, _| {
                    events.post(Event::Opened)
                }))?;
                let events = self.events.clone();
                player.MediaFailed(&TypedEventHandler::new(move |_, _| {
                    events.post(Event::Failed)
                }))?;
                let gpu = self
                    .gpu
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?
                    .clone();
                let surface = gpu.surface(&gpu.texture(self.width, self.height, false)?)?;
                self.preview_surface = Some(surface.clone());
                let surface = AgileReference::new(&surface)?;
                let preview = self.preview.clone();
                let events = self.events.clone();
                let width = self.width;
                let height = self.height;
                player.VideoFrameAvailable(&TypedEventHandler::new(
                    move |player: windows::core::Ref<'_, MediaPlayer>, _| {
                        if !events.control.active.load(Ordering::SeqCst)
                            || !events.control.alive.load(Ordering::SeqCst)
                        {
                            return Ok(());
                        }
                        let Ok(mut frames) = preview.try_lock() else {
                            return Ok(());
                        };
                        if frames.updated.elapsed() < Duration::from_millis(100) {
                            return Ok(());
                        }
                        frames.updated = Instant::now();
                        let result = (|| -> Result<Pixels> {
                            let surface = surface.resolve()?;
                            player.ok()?.CopyFrameToVideoSurface(&surface)?;
                            gpu.pixels(&surface, width, height)
                        })();
                        if !events.control.active.load(Ordering::SeqCst)
                            || !events.control.alive.load(Ordering::SeqCst)
                        {
                            return Ok(());
                        }
                        match result {
                            Ok(pixels) => {
                                frames.latest = Some(pixels);
                                Ok(())
                            }
                            Err(_) => events.post(Event::Failed),
                        }
                    },
                ))?;
                player.SetSource(&playback)?;
                self.playback = Some(playback);
                self.player = Some(player);
            }
            Event::Image(Ok(media)) => {
                self.media = Some(media);
                self.review()?;
            }
            Event::Opened => {
                let player = self
                    .player
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?;
                let playback = self
                    .playback
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?;
                let session = player.PlaybackSession()?;
                let ticks = session.NaturalDuration()?.Duration;
                if ticks <= 0
                    || ticks > self.request.duration_seconds.unwrap_or_default() as i64 * 10_000_000
                    || playback.AudioTracks()?.Size()? != 0
                    || session.NaturalVideoWidth()? != self.width
                    || session.NaturalVideoHeight()? != self.height
                {
                    self.finish(Err("failed"));
                    return Ok(());
                }
                player.Play()?;
                self.phase = Phase::Preview;
            }
            Event::Read(true) => {
                let reader = self
                    .reader
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?;
                let expected = self
                    .stream
                    .as_ref()
                    .ok_or_else(|| Error::from_hresult(E_FAIL))?
                    .Size()? as usize;
                if expected == 0
                    || expected > self.request.max_bytes
                    || reader.UnconsumedBufferLength()? as usize != expected
                {
                    self.finish(Err("failed"));
                    return Ok(());
                }
                let mut media = Media {
                    bytes: vec![0; expected],
                    width: self.width,
                    height: self.height,
                    duration_seconds: Some(
                        self.player
                            .as_ref()
                            .ok_or_else(|| Error::from_hresult(E_FAIL))?
                            .PlaybackSession()?
                            .NaturalDuration()?
                            .Duration as f64
                            / 10_000_000.0,
                    ),
                };
                reader.ReadBytes(&mut media.bytes)?;
                self.finish(Ok(media));
            }
            _ => self.finish(Err("failed")),
        }
        Ok(())
    }

    fn review(&mut self) -> Result<()> {
        self.phase = Phase::Preview;
        self.share()
    }

    fn share(&mut self) -> Result<()> {
        if self.phase != Phase::Preview
            || self.pixels.is_none()
            || !self.control.active.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        if self.request.expires_at <= super::now_ms() {
            self.finish(Err("cancelled"));
            return Ok(());
        }
        if self.request.kind == "image" {
            let media = self
                .media
                .take()
                .ok_or_else(|| Error::from_hresult(E_FAIL))?;
            self.finish(Ok(media));
        } else {
            self.phase = Phase::Reading;
            if let Some(player) = &self.player {
                player.Pause()?;
            }
            let stream = self
                .stream
                .as_ref()
                .ok_or_else(|| Error::from_hresult(E_FAIL))?;
            let size = stream.Size()?;
            if size == 0 || size > self.request.max_bytes as u64 {
                self.finish(Err("failed"));
                return Ok(());
            }
            let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0)?)?;
            let operation = reader.LoadAsync(size as u32)?;
            let events = self.events.clone();
            operation.SetCompleted(&AsyncOperationCompletedHandler::new(move |_, status| {
                events.post(Event::Read(status == AsyncStatus::Completed))
            }))?;
            self.reader = Some(reader);
            self.read = Some(operation);
        }
        Ok(())
    }

    fn close_capture(&mut self) {
        self.display_capture = None;
        if let Some(capture) = self.capture.take() {
            let _ = capture.Close();
        }
        if let Some(pool) = self.pool.take() {
            let _ = pool.Close();
        }
    }

    fn cleanup(&mut self) {
        self.close_capture();
        if let Some(item) = self.item.take() {
            if let Some(token) = self.closed_token.take() {
                let _ = item.RemoveClosed(token);
            }
        }
        if let Some(picker) = self.picker.take() {
            let _ = picker.Cancel();
        }
        if let Some(prepare) = self.prepare.take() {
            let _ = prepare.Cancel();
        }
        if let Some(transcode) = self.transcode.take() {
            let _ = transcode.Cancel();
        }
        if let Some(read) = self.read.take() {
            let _ = read.Cancel();
        }
        self.pending_sample = None;
        if let Some(player) = self.player.take() {
            let _ = player.Close();
        }
        self.playback = None;
        self.preview_surface = None;
        if let Ok(mut frames) = self.preview.lock() {
            frames.latest = None;
        }
        self.last_surface = None;
        self.pixels = None;
        self.media = None;
        self.source = None;
        self.transcoder = None;
        if let Some(reader) = self.reader.take() {
            let _ = reader.Close();
        }
        if let Some(stream) = self.stream.take() {
            let _ = stream.Close();
        }
    }

    fn finish(&mut self, result: std::result::Result<Media, &'static str>) {
        if self.phase == Phase::Done {
            return;
        }
        self.phase = Phase::Done;
        self.control.alive.store(false, Ordering::SeqCst);
        self.control.window.store(0, Ordering::SeqCst);
        self.result = Some(result);
        self.cleanup();
        unsafe {
            let _ = DestroyWindow(self.window);
            PostQuitMessage(0);
        }
    }
}

impl Drop for Ui {
    fn drop(&mut self) {
        self.control.alive.store(false, Ordering::SeqCst);
        self.control.window.store(0, Ordering::SeqCst);
        self.cleanup();
        unsafe {
            let _ = WTSUnRegisterSessionNotification(self.window);
            SetWindowLongPtrW(self.window, GWLP_USERDATA, 0);
            let _ = DestroyWindow(self.window);
        }
    }
}

fn output_size(width: u32, height: u32) -> (u32, u32) {
    let ratio = (1920.0 / width as f64).min(1080.0 / height as f64).min(1.0);
    (
        ((width as f64 * ratio) as u32 / 2 * 2).max(2),
        ((height as f64 * ratio) as u32 / 2 * 2).max(2),
    )
}

struct WindowData {
    state: RefCell<Ui>,
    control: Arc<Control>,
}

fn cancels_capture(message: u32, wparam: WPARAM) -> bool {
    message == WM_CLOSE
        || (message == WM_WTSSESSION_CHANGE
            && matches!(
                wparam.0 as u32,
                WTS_SESSION_LOCK
                    | WTS_SESSION_LOGOFF
                    | WTS_CONSOLE_DISCONNECT
                    | WTS_REMOTE_DISCONNECT
            ))
        || (message == WM_POWERBROADCAST && wparam.0 as u32 == PBT_APMSUSPEND)
        || (message == WM_ENDSESSION && wparam.0 != 0)
}

unsafe extern "system" fn window_proc(
    window: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let creation = &*(lparam.0 as *const CREATESTRUCTW);
        SetWindowLongPtrW(window, GWLP_USERDATA, creation.lpCreateParams as isize);
    }
    let pointer = GetWindowLongPtrW(window, GWLP_USERDATA) as *const WindowData;
    if !pointer.is_null() {
        let data = &*pointer;
        let cancelled = cancels_capture(message, wparam);
        if cancelled {
            data.control.active.store(false, Ordering::SeqCst);
        }
        if message == WM_NCDESTROY {
            if data.control.alive.load(Ordering::SeqCst) {
                data.control.active.store(false, Ordering::SeqCst);
                PostQuitMessage(0);
            }
            SetWindowLongPtrW(window, GWLP_USERDATA, 0);
            return DefWindowProcW(window, message, wparam, lparam);
        }
        let Ok(mut state) = data.state.try_borrow_mut() else {
            return if cancelled {
                LRESULT(0)
            } else {
                DefWindowProcW(window, message, wparam, lparam)
            };
        };
        let handled = catch_unwind(AssertUnwindSafe(|| -> Result<bool> {
            if cancelled {
                state.finish(Err("cancelled"));
                return Ok(true);
            }
            match message {
                WM_TIMER => {
                    state.tick()?;
                    Ok(true)
                }
                EVENT_MESSAGE => {
                    while let Ok(event) = state.incoming.try_recv() {
                        if state.phase == Phase::Done {
                            break;
                        }
                        state.handle(event)?;
                    }
                    Ok(true)
                }
                _ => Ok(false),
            }
        }));
        match handled {
            Ok(Ok(true)) => return LRESULT(0),
            Ok(Err(error)) => {
                eprintln!(
                    "Windows native capture failed (HRESULT 0x{:08X}); discarding.",
                    error.code().0 as u32
                );
                state.finish(Err("failed"));
                return LRESULT(0);
            }
            Err(_) => {
                state.finish(Err("failed"));
                return LRESULT(0);
            }
            _ => {}
        }
    }
    DefWindowProcW(window, message, wparam, lparam)
}

fn run(
    request: CaptureRequest,
    approval: super::consent::Context,
    saved_source: Option<String>,
    control: Arc<Control>,
) -> std::result::Result<Media, &'static str> {
    let _apartment = Apartment::new(RO_INIT_SINGLETHREADED).map_err(|_| "unsupported")?;
    let _dpi = DpiAwareness::enter().map_err(|_| "unsupported")?;
    let queue = unsafe {
        CreateDispatcherQueueController(DispatcherQueueOptions {
            dwSize: std::mem::size_of::<DispatcherQueueOptions>() as u32,
            threadType: DQTYPE_THREAD_CURRENT,
            apartmentType: DQTAT_COM_STA,
        })
    }
    .map_err(|_| "unsupported")?;
    let data = Box::new(WindowData {
        state: RefCell::new(Ui::new(request, approval, saved_source, control.clone())),
        control: control.clone(),
    });
    let result = (|| -> Result<()> {
        let mut state = data.state.borrow_mut();
        if !control.active.load(Ordering::SeqCst) || state.request.expires_at <= super::now_ms() {
            return Err(Error::from_hresult(E_FAIL));
        }
        let instance = unsafe { GetModuleHandleW(None)? };
        let class_name = w!("LumiverseNativeCapture");
        static CLASS: OnceLock<bool> = OnceLock::new();
        let registered = *CLASS.get_or_init(|| unsafe {
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                hInstance: instance.into(),
                lpszClassName: class_name,
                ..Default::default()
            }) != 0
        });
        if !registered {
            return Err(Error::from_hresult(E_FAIL));
        }
        let window = unsafe {
            // GraphicsCapturePicker and session notifications need an owner HWND,
            // but it has no controls, caption or visible capture window.
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class_name,
                w!("Lumiverse Capture"),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                Some(instance.into()),
                Some((&*data as *const WindowData).cast()),
            )?
        };
        state.window = window;
        control.window.store(window.0 as usize, Ordering::SeqCst);
        unsafe {
            WTSRegisterSessionNotification(window, NOTIFY_FOR_THIS_SESSION)?;
            if SetTimer(Some(window), 1, 33, None) == 0 {
                return Err(Error::from_hresult(E_FAIL));
            }
            let restored = state.saved_source.as_ref().and_then(|source| {
                let sources = sources().lock().unwrap();
                let saved = sources.get(source)?;
                if saved.closed.load(Ordering::SeqCst) {
                    return None;
                }
                saved.item.resolve().ok()
            });
            if state.request.display.is_some() {
                state.selected_display()?;
            } else if let Some(item) = restored {
                state.remembering = true;
                state.selected_source = state.saved_source.clone();
                state.selected(item)?;
            } else {
                if state.saved_source.is_some() {
                    state.approval.invalidate();
                }
                state.choose()?;
            }
            drop(state);
            let mut message = MSG::default();
            loop {
                let outcome = GetMessageW(&mut message, None, 0, 0).0;
                if outcome == -1 {
                    return Err(Error::from_hresult(E_FAIL));
                }
                if outcome == 0 {
                    break;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
        Ok(())
    })();
    let media = if result.is_ok() {
        data.state
            .borrow_mut()
            .result
            .take()
            .unwrap_or(Err("cancelled"))
    } else {
        Err("failed")
    };
    drop(data);
    if let Ok(shutdown) = queue.ShutdownQueueAsync() {
        let deadline = Instant::now() + Duration::from_secs(2);
        while shutdown
            .Status()
            .is_ok_and(|status| status == AsyncStatus::Started)
            && Instant::now() < deadline
        {
            unsafe {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    media
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn early_recording_end_is_short_and_includes_the_last_frame_without_exceeding_cutoff() {
        assert_eq!(recording_end_ticks(30, 25_000_000, 24_000_000), 25_000_000);
        assert_eq!(recording_end_ticks(30, 0, -1), FRAME_TICKS);
        assert_eq!(recording_end_ticks(30, 1_000_000, 1_000_000), 1_000_000 + FRAME_TICKS);
        assert_eq!(recording_end_ticks(1, 12_000_000, 9_900_000), 10_000_000);
    }

    #[test]
    #[ignore = "requires a Windows desktop with connected displays; metadata only"]
    fn connected_display_discovery() {
        let displays = displays();
        assert!(!displays.is_empty());
        for display in displays {
            assert!(display.width > 0 && display.height > 0);
            println!("{} · {} × {} · primary={}", display.name, display.width, display.height, display.primary);
        }
    }

    #[test]
    #[ignore = "reads one local frame from each connected Windows display; no files or uploads"]
    fn connected_display_frames() {
        let _apartment = Apartment::new(RO_INIT_MULTITHREADED).unwrap();
        let gpu = Gpu::new().unwrap();
        let displays = super::super::displays::snapshot("local-capture-test");
        assert!(!displays.is_empty());
        for display in displays {
            let capture = DisplayCapture::new(&display, super::super::MAX_PIXELS, &gpu).unwrap();
            assert_eq!(capture.size(), (display.width, display.height));
            let surface = capture.frame(&gpu).unwrap();
            let pixels = gpu.pixels(&surface, display.width, display.height).unwrap();
            assert_eq!(pixels.bytes.len(), (display.width * display.height * 4) as usize);
            assert!(pixels.bytes.chunks_exact(4).all(|pixel| pixel[3] == 255));
            println!("{}: captured {} × {} without a capture session or popup", display.name, display.width, display.height);
            let mut missing = display.clone();
            missing.identity = "disconnected-monitor".into();
            assert!(DisplayCapture::new(&missing, super::super::MAX_PIXELS, &gpu).is_err());
            assert!(DisplayCapture::new(&display, 1, &gpu).is_err());
        }
    }

    #[test]
    fn output_sizes_are_even_and_bounded() {
        assert_eq!(output_size(3840, 2160), (1920, 1080));
        assert_eq!(output_size(1921, 1081), (1918, 1080));
        let (width, height) = output_size(401, 301);
        assert_eq!(width % 2, 0);
        assert_eq!(height % 2, 0);
        assert!(width <= 1920 && height <= 1080);
    }

    #[test]
    fn png_writer_rejects_oversize_and_cancelled_buffers() {
        let active = Arc::new(AtomicBool::new(true));
        let mut writer = LimitedWriter {
            bytes: Vec::new(),
            maximum: 4,
            active: active.clone(),
            alive: Arc::new(AtomicBool::new(true)),
        };
        assert_eq!(writer.write(&[1, 2, 3, 4]).unwrap(), 4);
        assert!(writer.write(&[5]).is_err());
        active.store(false, Ordering::SeqCst);
        assert!(writer.write(&[]).is_err());
        active.store(true, Ordering::SeqCst);
        writer.alive.store(false, Ordering::SeqCst);
        assert!(writer.write(&[]).is_err());
    }

    #[test]
    fn window_and_session_cancellation_cannot_be_bypassed() {
        assert!(cancels_capture(WM_CLOSE, WPARAM(0)));
        assert!(cancels_capture(WM_ENDSESSION, WPARAM(1)));
        assert!(!cancels_capture(WM_ENDSESSION, WPARAM(0)));
        for notification in [
            WTS_SESSION_LOCK,
            WTS_SESSION_LOGOFF,
            WTS_CONSOLE_DISCONNECT,
            WTS_REMOTE_DISCONNECT,
        ] {
            assert!(cancels_capture(
                WM_WTSSESSION_CHANGE,
                WPARAM(notification as usize)
            ));
        }
        assert!(cancels_capture(
            WM_POWERBROADCAST,
            WPARAM(PBT_APMSUSPEND as usize)
        ));
        assert!(!cancels_capture(
            WM_WTSSESSION_CHANGE,
            WPARAM(WTS_SESSION_UNLOCK as usize)
        ));
        assert!(!cancels_capture(WM_COMMAND, WPARAM(103)));
    }
}
