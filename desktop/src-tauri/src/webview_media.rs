//! WebKitGTK needs an explicit MediaStream setting and permission handler.

fn is_frontend_microphone_request(
    uri: Option<&str>,
    expected_origin: &str,
    audio: bool,
    video: bool,
) -> bool {
    audio
        && !video
        && uri
            .and_then(|uri| tauri::Url::parse(uri).ok())
            .is_some_and(|url| url.origin().ascii_serialization() == expected_origin)
}

#[cfg(target_os = "linux")]
pub fn configure_frontend_microphone(window: &tauri::WebviewWindow) -> Result<(), String> {
    use gtk::prelude::*;
    use std::{cell::Cell, rc::Rc};
    use webkit2gtk::{
        PermissionRequestExt, SettingsExt, UserMediaPermissionRequestExt, WebViewExt,
    };

    let expected_origin = window
        .url()
        .map_err(|error| error.to_string())?
        .origin()
        .ascii_serialization();
    window
        .with_webview(move |platform| {
            let webview = platform.inner();
            if let Some(settings) = WebViewExt::settings(&webview) {
                settings.set_enable_media_stream(true);
                settings.set_enable_webaudio(true);
            }

            // Remember the user's choice for this frontend window and origin only.
            let approved = Rc::new(Cell::new(false));
            webview.connect_permission_request(move |webview, request| {
                let Some(media) = request.downcast_ref::<webkit2gtk::UserMediaPermissionRequest>()
                else {
                    return false;
                };
                if !is_frontend_microphone_request(
                    webview.uri().as_deref(),
                    &expected_origin,
                    media.is_for_audio_device(),
                    media.is_for_video_device(),
                ) {
                    request.deny();
                    return true;
                }
                if approved.get() {
                    request.allow();
                    return true;
                }

                // WebKitGTK's default handler denies the request. Supply the native
                // permission prompt that a full browser normally presents.
                let parent = webview
                    .toplevel()
                    .and_then(|widget| widget.downcast::<gtk::Window>().ok());
                let dialog = gtk::MessageDialog::new(
                    parent.as_ref(),
                    gtk::DialogFlags::MODAL,
                    gtk::MessageType::Question,
                    gtk::ButtonsType::None,
                    "Allow Lumiverse to use your microphone?",
                );
                dialog.set_secondary_text(Some(&format!(
                    "Requested by {expected_origin} for voice dictation."
                )));
                dialog.add_button("Cancel", gtk::ResponseType::Cancel);
                dialog.add_button("Allow", gtk::ResponseType::Yes);
                dialog.set_default_response(gtk::ResponseType::Cancel);
                let weak_webview = webview.downgrade();
                let request = request.clone();
                let origin = expected_origin.clone();
                let approved = approved.clone();
                dialog.connect_response(move |dialog, response| {
                    let current = weak_webview.upgrade().and_then(|view| view.uri());
                    if response == gtk::ResponseType::Yes
                        && is_frontend_microphone_request(current.as_deref(), &origin, true, false)
                    {
                        approved.set(true);
                        request.allow();
                    } else {
                        request.deny();
                    }
                    // Destroy after resolving; Dialog::close() can emit another response.
                    unsafe { dialog.destroy() };
                });
                dialog.show_all();
                true
            });
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::is_frontend_microphone_request;

    #[test]
    fn allows_only_audio_for_the_frontend_origin() {
        let origin = "https://app.lumiverse.chat";
        assert!(is_frontend_microphone_request(
            Some("https://app.lumiverse.chat/chat/1"),
            origin,
            true,
            false
        ));
        assert!(!is_frontend_microphone_request(
            Some(origin),
            origin,
            true,
            true
        ));
        assert!(!is_frontend_microphone_request(
            Some(origin),
            origin,
            false,
            false
        ));
        assert!(!is_frontend_microphone_request(
            Some("https://other.example"),
            origin,
            true,
            false
        ));
        assert!(!is_frontend_microphone_request(
            Some("http://app.lumiverse.chat"),
            origin,
            true,
            false
        ));
        assert!(!is_frontend_microphone_request(None, origin, true, false));
        assert!(!is_frontend_microphone_request(
            Some("not a URL"),
            origin,
            true,
            false
        ));
    }
}
