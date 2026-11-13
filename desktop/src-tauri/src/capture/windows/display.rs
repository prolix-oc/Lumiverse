//! Explicit displays use the desktop's existing tray and extension grants.
//! GDI supplies display pixels without a picker, capture window, or WGC border.
use std::ffi::c_void;
use windows::{
    core::{Error, Result},
    Graphics::DirectX::Direct3D11::IDirect3DSurface,
    Win32::{
        Foundation::{E_FAIL, RECT},
        Graphics::{Direct3D11::ID3D11Texture2D, Gdi::*},
        UI::HiDpi::{
            SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
        },
    },
};

use super::{monitor_info, Gpu};

// Keep metadata and capture coordinates in physical pixels on mixed-DPI desktops.
// Restore the caller's thread context rather than changing process-wide settings.
pub(super) struct DpiAwareness(DPI_AWARENESS_CONTEXT);

impl DpiAwareness {
    pub fn enter() -> Result<Self> {
        let previous = unsafe {
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)
        };
        if previous.0.is_null() {
            return Err(Error::from_hresult(E_FAIL));
        }
        Ok(Self(previous))
    }
}

impl Drop for DpiAwareness {
    fn drop(&mut self) {
        unsafe { SetThreadDpiAwarenessContext(self.0); }
    }
}

pub(super) struct DisplayCapture {
    monitor: HMONITOR,
    identity: String,
    rect: RECT,
    screen: HDC,
    buffer: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut c_void,
    texture: ID3D11Texture2D,
    _dpi: DpiAwareness,
}

impl DisplayCapture {
    pub fn new(display: &super::super::displays::Display, max_pixels: u64, gpu: &Gpu) -> Result<Self> {
        let dpi = DpiAwareness::enter()?;
        let monitor = super::display_monitors()
            .into_iter()
            .find(|(native, _)| native.identity == display.identity)
            .map(|(_, monitor)| monitor)
            .ok_or_else(|| Error::from_hresult(E_FAIL))?;
        let (native, rect) = monitor_info(monitor).ok_or_else(|| Error::from_hresult(E_FAIL))?;
        if native.width as u64 * native.height as u64 > max_pixels {
            return Err(Error::from_hresult(E_FAIL));
        }
        let texture = gpu.texture(native.width, native.height, false)?;
        let mut capture = Self {
            monitor,
            identity: display.identity.clone(),
            rect,
            screen: HDC::default(),
            buffer: HDC::default(),
            bitmap: HBITMAP::default(),
            previous: HGDIOBJ::default(),
            bits: std::ptr::null_mut(),
            texture,
            _dpi: dpi,
        };
        unsafe {
            capture.screen = GetDC(None);
            if capture.screen.is_invalid() {
                return Err(Error::from_hresult(E_FAIL));
            }
            capture.buffer = CreateCompatibleDC(Some(capture.screen));
            if capture.buffer.is_invalid() {
                return Err(Error::from_hresult(E_FAIL));
            }
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: native.width as i32,
                    // A top-down DIB follows the monitor's current rotation, including portrait.
                    biHeight: -(native.height as i32),
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            capture.bitmap = CreateDIBSection(
                Some(capture.screen), &info, DIB_RGB_COLORS, &mut capture.bits, None, 0,
            )?;
            if capture.bits.is_null() {
                return Err(Error::from_hresult(E_FAIL));
            }
            capture.previous = SelectObject(capture.buffer, capture.bitmap.into());
            if capture.previous.is_invalid() {
                return Err(Error::from_hresult(E_FAIL));
            }
        }
        Ok(capture)
    }

    pub fn size(&self) -> (u32, u32) {
        (
            (self.rect.right - self.rect.left) as u32,
            (self.rect.bottom - self.rect.top) as u32,
        )
    }

    pub fn frame(&self, gpu: &Gpu) -> Result<IDirect3DSurface> {
        // Recheck identity and geometry before each frame so unplugging/replacing a
        // monitor, changing rotation, or moving displays cannot capture another screen.
        let (native, rect) = monitor_info(self.monitor).ok_or_else(|| Error::from_hresult(E_FAIL))?;
        if native.identity != self.identity || rect != self.rect {
            return Err(Error::from_hresult(E_FAIL));
        }
        let (width, height) = self.size();
        unsafe {
            BitBlt(
                self.buffer, 0, 0, width as i32, height as i32, Some(self.screen),
                self.rect.left, self.rect.top, SRCCOPY | CAPTUREBLT,
            )?;
            GdiFlush().ok()?;
            // BI_RGB does not define alpha. Supply opaque BGRA to both encoders.
            let bytes = std::slice::from_raw_parts_mut(
                self.bits as *mut u8, width as usize * height as usize * 4,
            );
            for pixel in bytes.chunks_exact_mut(4) {
                pixel[3] = 255;
            }
            gpu.context.UpdateSubresource(&self.texture, 0, None, self.bits, width * 4, 0);
        }
        // Samples can outlive this tick. Give the encoder its own immutable texture.
        gpu.copy(&gpu.surface(&self.texture)?, width, height)
    }
}

impl Drop for DisplayCapture {
    fn drop(&mut self) {
        unsafe {
            if !self.bits.is_null() {
                let (width, height) = self.size();
                std::slice::from_raw_parts_mut(
                    self.bits as *mut u8, width as usize * height as usize * 4,
                ).fill(0);
            }
            if !self.previous.is_invalid() {
                SelectObject(self.buffer, self.previous);
            }
            if !self.bitmap.is_invalid() {
                let _ = DeleteObject(self.bitmap.into());
            }
            if !self.buffer.is_invalid() {
                let _ = DeleteDC(self.buffer);
            }
            if !self.screen.is_invalid() {
                ReleaseDC(None, self.screen);
            }
        }
    }
}
