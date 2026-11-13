//! A shared surface contract, implemented using each WebView's opaque path.

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SurfaceMode {
    Opaque,
    Translucent,
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // Every backend is exercised by the policy tests on each host.
pub enum Backend {
    WebKit,
    WebView2,
    WebKitGtk,
}

impl Backend {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::WebKit
        } else if cfg!(target_os = "windows") {
            Self::WebView2
        } else {
            Self::WebKitGtk
        }
    }
}

impl SurfaceMode {
    pub fn resolve(
        requested: Option<Self>,
        force_opaque: bool,
        debug_override: Option<Self>,
    ) -> Self {
        if force_opaque {
            Self::Opaque
        } else {
            // Old remote frontends don't send a mode. Preserve their existing
            // transparent host until a newer frontend explicitly opts in.
            debug_override.or(requested).unwrap_or(Self::Translucent)
        }
    }

    pub fn allows_blur(self, requested: bool) -> bool {
        self == Self::Translucent && requested
    }

    pub fn webview_background(self, backend: Backend, rgb: [u8; 3]) -> Option<[u8; 4]> {
        match (self, backend) {
            // Wry 0.55 disables WKWebView's drawsBackground whenever a custom
            // WebView color is supplied, even if its alpha is 255. Leave it
            // unset; tint only the native Window and the opaque HTML surface.
            (Self::Opaque, Backend::WebKit) => None,
            (Self::Opaque, _) => Some([rgb[0], rgb[1], rgb[2], 255]),
            (Self::Translucent, _) => Some([0, 0, 0, 0]),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_backend_uses_its_opaque_webview_path() {
        let rgb = [61, 20, 32];
        assert_eq!(
            SurfaceMode::Opaque.webview_background(Backend::WebKit, rgb),
            None
        );
        for backend in [Backend::WebView2, Backend::WebKitGtk] {
            assert_eq!(
                SurfaceMode::Opaque.webview_background(backend, rgb),
                Some([61, 20, 32, 255])
            );
        }
        for backend in [Backend::WebKit, Backend::WebView2, Backend::WebKitGtk] {
            assert_eq!(
                SurfaceMode::Translucent.webview_background(backend, rgb),
                Some([0, 0, 0, 0])
            );
        }
    }

    #[test]
    fn opaque_windows_never_accept_native_blur() {
        assert!(!SurfaceMode::Opaque.allows_blur(true));
        assert!(SurfaceMode::Translucent.allows_blur(true));
        assert!(!SurfaceMode::Translucent.allows_blur(false));
    }

    #[test]
    fn legacy_clients_and_linux_emergency_override_remain_compatible() {
        assert_eq!(
            SurfaceMode::resolve(None, false, None),
            SurfaceMode::Translucent
        );
        assert_eq!(
            SurfaceMode::resolve(Some(SurfaceMode::Opaque), false, None),
            SurfaceMode::Opaque
        );
        assert_eq!(
            SurfaceMode::resolve(None, false, Some(SurfaceMode::Opaque)),
            SurfaceMode::Opaque
        );
        assert_eq!(
            SurfaceMode::resolve(
                Some(SurfaceMode::Translucent),
                true,
                Some(SurfaceMode::Translucent)
            ),
            SurfaceMode::Opaque
        );
    }
}
