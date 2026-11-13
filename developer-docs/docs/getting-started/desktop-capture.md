# Desktop capture from a Spindle worker

The first integration exposes `spindle.desktop.capture` in backend extension workers. It does not expose a frontend capture API, native IPC commands, filesystem paths, browser media streams, or raw capture bytes to extensions.

The desktop client includes an opt-in native transport and macOS/Windows adapters. On macOS 14+ or Windows 10 1903+/Windows 11, use **Set Up Screen Capture** in the extension's permissions area, or the top-level **Let Extensions Capture the Screen** toggle beside system audio in the desktop tray. Setup opens trusted desktop controls and connects the selected local or remote instance through native OAuth. Capture is disabled by default. The toggle stays enabled until the user turns it off. After explicit setup, the transport reconnects for that same selected instance using existing native credentials, including after restart or transport failure. Interrupted captures are canceled and never replayed. Until connected, `listDevices()` returns an empty list. The host capability `desktop-capture-worker-v1` describes protocol availability, not OS capture support or permission.

Linux still advertises no capture capability: its portal/GPU encoder integration is not implemented. There is no browser, X11, or FFmpeg capture fallback. Replay buffers are not implemented or advertised on any platform yet.

Capture requests have a five-minute setup/record/encode/upload deadline. A native
upload can take up to two minutes within that deadline and keeps its authenticated
device lease alive during the transfer. The 256 MiB broker budget accounts for
retained and incoming decoded media; base64 JSON and framework copies add transient
memory overhead. Provider request-size limits apply independently of these host limits.

## Native macOS adapter

- There is no Capture & Send window, local review panel, or second Send step. Missing screen-recording permission is requested directly through macOS; existing app-wide permission is reused. System-audio-only permission does not authorize screen capture.
- First use opens a native menu of displays and other apps' windows. Selecting a source starts capture and remembers the approval immediately, independently of whether that capture succeeds or is canceled. Later matching requests capture that same source without another picker. Display identity is stored using its native UUID. Window identity is limited to the current desktop process and owning application lifetime; it is never restored by matching a title. Missing sources ask for a new choice without selecting a replacement automatically.
- Remembered approval is native and scoped to the instance, OAuth account, installation, capture kind, current permission-grant fingerprint, connection revision and destination. Image approval does not authorize video. Revoking and regranting capture or generation permission changes the fingerprint even if the desktop was offline. Older commands without these fingerprints remain one-shot and cannot create remembered approval.
- Screenshots use `SCScreenshotManager` and stay in native memory. Video uses `SCStream` with hardware-required VideoToolbox/AVAssetWriter H.264 encoding, at most 1920×1080/30fps, an 8 Mbps average bitrate target, and 1–120 seconds. Audio and microphone capture remain disabled. A private temporary MP4 is removed after completion/cancellation; abandoned directories are cleaned on startup. File deletion and best-effort buffer clearing do not guarantee secure erasure from SSDs, swap or framework copies.
- A native menu-bar indicator shows the extension, destination and recording countdown. **Cancel This Capture** discards only the current request and preserves saved permissions. Only explicitly turning off **Let Extensions Capture the Screen** in the desktop tray disables requests and forgets saved approvals. This disabled state survives restart. Turning the toggle on again enables requests without starting a capture; the next request requires source selection.
- Expiry, screen lock/session inactivity, source loss, permission revocation, instance/account changes and transport loss cancel pending work. Screen permission is checked before capture, during permissioned capture and before release. Source identities and media stay native. There is no always-on buffer.

`listDevices()` lists connected desktop clients. Updated clients include a `displays` array containing each connected display's opaque ID, name, pixel dimensions and primary flag. Display discovery reads metadata only and does not request screen-recording permission or capture pixels. Windows and applications remain private to the native picker. Do not redirect a saved target to another device or display. Refresh discovery when the saved target becomes unavailable.

### Persistent source approval

Source selection authorizes this image or bounded clip and release to the displayed instance/model, plus future matching requests using that same source while the tray toggle remains enabled. Turning capture off removes saved approvals. There is no capture window, local review step, or second Send click. Canceling a request preserves its saved source approval. An extension can request a specific published display by ID, but cannot grant approval, write native approval records, or enable capture through a request flag.

For selected Windows displays, the flow is extension **Share** → capture and validation → opaque asset return → generation/optional TTS. The native tray opt-in and current extension grants authorize capture directly. Picker sources still require source selection on first use, then reuse matching remembered approval. The broker checks permissions, worker/account ownership and the exact connection revision before delivering or consuming an asset. Discard before release uploads nothing; a released upload cannot be recalled.

Requests may include an optional `displayId`. Windows captures that exact display under the existing tray and extension grants; macOS keeps separate native source approval. Omitting it retains the native picker behavior. Native commands also include an opaque destination revision and permission-grant fingerprint; no connection secrets are exposed. Only request a display published by that device; older clients omit `displays` and continue using the picker.

## Gemini input media detail

Google (`google`) and Gemini routes on Vertex (`google_vertex`) accept the optional
request-wide `parameters.media_resolution` setting on raw and quiet generation.
Values are `low`, `medium`, `high`, or `unspecified`; native
`MEDIA_RESOLUTION_*` spellings and the `mediaResolution` alias also work. The
adapter serializes this as `generationConfig.mediaResolution` alongside thinking
and other generation settings. Omitting it keeps inherited settings/provider
defaults; `unspecified` explicitly chooses the provider default. Raw calls inherit
media detail from the connection's bound custom body or preset without importing
unrelated preset sampling parameters. Explicit `media_resolution` takes precedence.

```ts
const stream = spindle.generate.rawStream({
  type: 'raw', provider: 'google', model: 'gemini-3.8-flash',
  connection_id: connection.id,
  messages: [{ role: 'user', content: [
    { type: 'text', text: 'Read the small text in this capture.' },
    { type: 'desktop_capture', asset_id: media.assetId },
  ] }],
  parameters: { media_resolution: 'high' },
  reasoning: { source: 'inherit' },
});
```

This controls model input detail and token allocation. It does not resize or
compress an attachment. Request-wide ultra-high is rejected because it is a
per-part setting; per-part resolution overrides are not exposed here. Model/API
support still applies. See Google's [GenerateContent media-resolution guide](https://ai.google.dev/gemini-api/docs/generate-content/media-resolution).

## Optional capture optimization

Workers on hosts advertising `desktop-capture-optimize-v1` can call
`desktop.capture.optimize()` between capture and raw generation. It reuses Sharp
for images and the existing [`media.transcodeVideo()`](../backend-api/media.md)
implementation for video, without exposing bytes or paths to the worker.

```ts
const optimized = await spindle.desktop.capture.optimize({
  assetId: captured.assetId, connectionId: captured.connectionId, userId,
  kind: 'video', maxEdge: 1280, fps: 15, bitrateKbps: 2500,
});
// Attach optimized.assetId through the existing desktop_capture message part.
```

`DesktopCaptureOptimizeRequest` is a discriminated union:

| Kind | Controls |
| --- | --- |
| `image` | `maxEdge` 256–3840 px; `format` jpeg/webp/png; `quality` 1–100 (ignored for lossless PNG) |
| `video` | `maxEdge` 256–3840 px; `fps` 1–30; `bitrateKbps` 128–8000 |

Dimensions preserve orientation and aspect ratio without enlargement; video uses
even dimensions, H.264 MP4/yuv420p and no audio. Bitrate is a target, not an exact
file-size guarantee. This runs after upload and reduces the model attachment; the
native baseline and initial upload remain unchanged. Conversion is explicit and
may re-encode even when dimensions already fit. Native encoder controls and a
target-size mode remain future work. Omitting optimization keeps baseline quality.

Successful conversion replaces the bytes behind the **same** single-use handle and
returns actual MIME type, dimensions, duration, `byteSize`, original connection and
original expiry. Ownership, permission-grant fingerprint and destination revision
are checked before and after processing. A failed conversion preserves the original
handle until its normal release/expiry; callers decide whether to stop sharing.
Releasing the handle cancels its job. Runtime revocation, device disconnect and
asset expiry also abort processing. Generation cannot consume a processing handle.

Jobs are limited to two globally and one per asset, with a 90-second deadline
bounded by the original asset expiry. Retained source plus reserved output count
against the 256 MiB broker budget; output remains limited to 8 MiB/image or
128 MiB/video. FFmpeg uses two threads, bounded temporary output and private
temporary input/output files removed after processing; memory/framework copies and
OS paging are outside this accounting. A size-limited output that truncates the
clip is rejected. Backend FFmpeg is required for video. No native capture changes
or extra permissions are needed beyond the existing capture and generation grants.

## Native Windows adapter

- A dedicated STA thread opens `GraphicsCapturePicker` directly when a new source is needed. An invisible native owner window supplies the picker handle and receives session notifications; it has no capture controls or visible HUD. Selecting a source authorizes capture and send and remembers the exact OS-selected item immediately. Subsequent matching requests reuse that item while the desktop process and source remain alive. After restart or source closure, the system picker is required again; window titles are never used to find a replacement. The picker selects one window or display; the OS capture border is not suppressed.
- For an explicit `displayId`, the tray opt-in and current extension capture/generation grants authorize capture without another Yes dialog or OS picker. GDI `BitBlt` copies only that monitor into a bounded native bitmap and uploads it to the existing Direct3D encoder pipeline, without a Windows Graphics Capture session or border. Metadata and capture use per-monitor DPI awareness and physical pixels. Identity and geometry are rechecked before each frame; source loss, rotation, or movement stops capture without falling back to another display. The widget shows workflow progress. The generic native-picker option retains its OS border and source selection.
- Availability requires UniversalApiContract v8 (Windows 10 1903+) and `GraphicsCaptureSession.IsSupported()`, plus a hardware D3D11 device. A free-threaded two-frame capture pool supplies GPU surfaces. Source size is validated before starting; source resize/closure cancels rather than capturing stale/padded pixels.
- Screenshots use a bounded native-memory PNG encoder. Video uses GPU-backed `MediaStreamSource` samples and `MediaTranscoder`, with `HardwareAccelerationEnabled = true`. This is **hardware-preferred, not hardware-guaranteed**: Windows may select software H.264. Capability probing does not prove encoder selection or codec availability; actual preparation can still reject recording. macOS's hardware-required policy is unchanged.
- Recordings omit audio and use at most 1920×1080/30fps, an 8 Mbps bitrate target, and the requested 1–120 seconds. The MP4 stays in `InMemoryRandomAccessStream`; its size is monitored and oversized output is discarded. The 128 MiB release limit is not a hard allocator limit on transient framework buffers. Native MediaPlayer playback checks the actual duration, dimensions, and absence of audio, and must produce a decoded frame before automatic release. This validation does not open a preview window.
- Cancellation, command expiry, source closure/resize, Windows session lock/logoff/disconnect, suspend, permission/worker cancellation, and transport shutdown discard native state. Session notification registration must succeed. Sample deferrals are completed even on cancellation, queue overflow, or native errors; callbacks/preview slots are bounded. Source selection or a matching remembered native approval authorizes release; media validation still runs before delivery. Canceling a request preserves saved approval. Explicitly turning the tray toggle off stops pending capture, disables requests and forgets approvals; automatic reconnect cannot re-enable it.
- No Windows recording file is created, but OS swap and framework copies are outside the buffer-clearing guarantee. Windows N systems may need the Media Feature Pack for H.264 recording/playback. Test on a physical Windows session; CI/cross-compilation cannot validate picker consent, drivers, encoder choice, or screen-lock behavior.

Native credentials, device leases, frames, file paths, and previews do not cross Tauri IPC. Enable/disable/status and approval-reset commands are scoped to the bundled `main` tray window, checked again against its label and URL in Rust, and explicitly declared in the application ACL. The primary frontend has only a setup-request command, which opens trusted desktop setup; it cannot enable capture or grant approval. The native transport verifies the OAuth account before registration and after token changes; a different account cannot inherit the active device lease or consent context. Local instance capture may require a separate desktop OAuth sign-in; the integrated browser's cookie is not reused.

Hardware capture, actual picker behavior, screen-lock cancellation, video playback, and byte/duration bounds require an on-device acceptance test before release. Compiling or running protocol tests does not validate those OS interactions.

### On-device acceptance

1. Use the extension permissions area's setup button for local and remote instances. Confirm native OAuth account/instance identity, then restart and interrupt/recover transport. Availability should reconnect only for the saved selected instance; interrupted requests must fail without being replayed.
2. On macOS, test with screen permission denied, granted and already granted. Confirm only the macOS permission prompt and native source menu appear, with no Capture & Send window. Selecting a source must start capture immediately. Repeat the request without another picker, then request video and require separate source approval. Revoke screen permission during recording and confirm discard.
3. Remember a display and restart the app; only that same display UUID may restore. Remove that display and confirm source selection without capturing another display. For windows, close/reopen the application or restart Desktop and confirm fresh selection. On Windows, repeat requests in one desktop process without another picker, then close the source/restart and require the system picker again.
4. Cancel a capture from the native indicator, dismiss source selection, and interrupt a recording. Confirm saved approvals and the tray toggle remain enabled, and another matching request needs no new permission. Then uncheck **Let Extensions Capture the Screen** and confirm the tray toggle is off and approvals are forgotten. Reload the extension and restart Desktop: capture must remain off without automatic reconnect. Enable the toggle again; it must not capture by itself, and the next request requires fresh source selection. Switch accounts/instances, reinstall the extension, or revoke/regrant capture or generation permission while Desktop is offline; no old approval may be reused.
5. Verify 1-second and 120-second clips, dimensions, no audio, playback, byte limits, encoder requirements, screen-lock/sleep cancellation, worker unload and network loss. Verify both first-use and remembered requests complete without a capture or preview window. Confirm canceled work never reaches generation and native indicators disappear after completion.
6. Send forged setup/control calls from remote content and floating widgets. Only the primary frontend may request setup; native enable/reset commands and media/source identities must stay inaccessible. Test old command envelopes and old desktop builds. Existing native prompt limits apply to requests needing setup; remembered requests still obey broker capture cooldowns and resource limits.
7. Confirm the same device ID after reconnect, app restart and backend restart, with fresh private leases and canceled old work. Approval discovery must not prompt, record, choose a source or change an approval. Verify remembered, required, paused, missing-source and permission-required states, including revoke/regrant while a query is pending. Older clients must report unknown without receiving an unsupported query.
8. With three connected displays, verify all three appear with physical pixel dimensions and primary status, including mixed-DPI and portrait layouts. Select each independently for screenshots and video. On Windows, tray opt-in plus extension grants must allow capture without another dialog or capture border; the native picker remains a separate option. Disconnect the selected monitor while idle and during capture; it must become unavailable without switching displays. Reconnect it and refresh discovery. On macOS, the native source menu for an explicit display must contain only that display.

## Extension permissions

Declare `screen_capture` for images, `screen_recording` for video, and `generation` to send approved captures to a model. Both capture permissions are privileged and never auto-granted. Native tray opt-in is also required. A selected Windows display uses these existing approvals directly; picker sources additionally require source selection or matching remembered source approval.

An extension must select an explicit desktop device and an owned connection profile. Captures are bound to the worker runtime, extension installation, user, and connection revision. Changing the provider, model, endpoint, or connection configuration invalidates a handle. Handles expire after two minutes and are consumed once. Unload, capture/generation permission revocation, or native device disconnect cancels pending requests and removes retained captures.

```ts
const devices = await spindle.desktop.capture.listDevices()
if (!devices.length) return

const capture = await spindle.desktop.capture.request({
  deviceId: devices[0].id,
  connectionId,
  purpose: 'Describe the selected application window',
  kind: 'image',
})

await spindle.generate.raw({
  connection_id: connectionId,
  provider,
  model,
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this screenshot.' },
      { type: 'desktop_capture', asset_id: capture.assetId },
    ],
  }],
})
```

Operator-scoped extensions must supply `userId`; user-scoped extensions cannot switch ownership by supplying a different user. Use `capture.release(assetId)` to discard an unused capture. References are supported only in raw generation and raw streaming, not batch/quiet generation or normal chat persistence.

To offer a monitor dropdown, feature-detect `desktop-capture-displays-v1`, refresh `listDevices()`, and render each device's optional `displays` array. Save both the device ID and display ID. Pass `displayId` to both `getApprovalStatus` and `request`:

```ts
const device = devices.find(device => device.displays?.length)
const display = device?.displays?.[0]
if (!device || !display) return
const capture = await spindle.desktop.capture.request({
  deviceId: device.id, displayId: display.id, connectionId,
  purpose: 'Describe this display', kind: 'image',
})
```

Display IDs are scoped to the native installation, instance and OAuth account. Native handles and hardware identifiers stay private. Topology changes update the published list; unknown or removed display IDs fail rather than capturing another source.

For video, use `kind: 'video'`, `mode: 'record' | 'replay'`, and `durationSeconds` (1–120). A replay request is not an instruction to arm recording: it may export only from a buffer already explicitly armed in trusted native UI. The provider allowlist accepts images for Google, Google Vertex, OpenAI, Anthropic, OpenRouter, and the Z.ai GLM-5.3-Flash family. Video supports Google, Gemini-protocol Google Vertex models (`google_vertex`), and Z.ai `glm-5.3-flash`, `glm-5.3-flashx`, and `glm-5.3-flashx-legal`. The Z.ai adapter serializes private MP4 bytes as an inline `video_url` data URL; it does not publish a recording URL. Text-only GLM models remain unsupported. The chosen model must support the supplied media. Unsupported providers are rejected rather than silently dropping media. Capture-backed generation rejects caller parameters that override models, routing, destinations, or message bodies.

### Finish a recording early

Treat `durationSeconds` as the maximum length. If the host advertises `desktop-capture-finish-v1` and the chosen device has `recordingControlSupported: true`, supply a unique caller-generated `requestKey` to `capture.request()`. Calling `capture.finish(requestKey, { userId })` finalizes that pending record-mode video; the original promise resolves with its actual shorter duration. The extension can use a second invocation of its existing share action to call this method. No additional command or keybinding is necessary.

```ts
const requestKey = crypto.randomUUID()
const pending = spindle.desktop.capture.request({
  deviceId, connectionId, requestKey, kind: 'video', mode: 'record',
  durationSeconds: 30, purpose: 'React to this clip', userId,
})
// When the user invokes the same action again while recording:
await spindle.desktop.capture.finish(requestKey, { userId })
const clip = await pending
```

Finish is idempotent and scoped to the same worker runtime, extension installation and authenticated account. It returns false if no matching request remains. It never starts a capture, selects a source, grants consent, disables capture, or sends media to a new destination. Repeated finish requests do not queue duplicate work. Permissions and connection authorization are rechecked. If finish arrives during source/encoder preparation, the adapter remembers it and finishes after a valid first frame. Cancellation, expiry and revocation still discard the clip. Older hosts/devices retain their duration cutoff.

Native device registration advertises `recordingControl: true`; the broker exposes it as `recordingControlSupported`. A finish operation adds `{ type: 'finish', requestId }` to that device's authenticated command queue. Updated Windows and macOS adapters finalize the matching active video without deactivating its cancellation guard.

## Native-client protocol

### Stable devices and approval discovery

New desktop clients keep the same `device.id` across reconnects and restarts for
the same desktop installation, instance and OAuth account. `stableIdentity: true`
identifies this support. Extensions can remember that ID as the user's device
choice rather than asking for a new registration on every reconnect. A device
still disappears from `listDevices()` while offline. Its private transport lease
rotates on reconnect, and interrupted captures/assets are canceled.

Use `spindle.desktop.capture.getApprovalStatus({ deviceId, connectionId, kind, userId? })`
to query approval for this extension installation, capture kind, permission-grant
revision and exact model destination. It requires the same capture and generation
permissions and connection ownership as a capture request. The backend advertises
`desktop-capture-approval-status-v1` for method discovery.

```ts
const status = await spindle.desktop.capture.getApprovalStatus({
  deviceId: savedDeviceId, connectionId, kind: 'image',
})
// status.approval: 'required' | 'remembered' | 'paused' | 'unavailable' | 'unknown'
// status.source: 'ready' | 'missing' | 'permission_required' | 'unknown'
// status.checkedAt: backend timestamp in milliseconds
```

Discovery never opens a picker, requests OS permission, starts capture or creates
an approval. It returns no native source handles, window titles, media, or credentials.
`remembered` reports an effective approval (the existing tray and extension grants for selected Windows displays, or a saved picker approval); `source` separately describes whether its
source can currently be reused. `paused` requires the owner to re-enable capture from the tray. Updated clients disconnect when capture is turned off, so device discovery may instead report the device unavailable.
Older desktops without `approvalStatusSupported` return `unknown` without receiving
an unsupported native command. Older desktops also keep session-only device IDs.

Status is advisory and can change immediately; it is not an authorization token.
A later capture always rechecks permissions and native consent/source availability.

### Transport

All routes are under `/api/desktop/v1/capture` and require the existing desktop OAuth access token, verified audience/issuer, and the `lumiverse-desktop` authorized client. Do not call them from extension/frontend JavaScript or expose the access token or lease token to a WebView.

- `POST /devices`: register `{ name, platform, capabilities: { image, video, replay }, deviceKey?, approvalStatus? }`; returns a device descriptor and a private `transportToken`. New native clients send a persistent opaque 64-character device key scoped to instance/account and `approvalStatus: true`; the key is never exposed to extensions.
- `GET /devices/:deviceId/commands`: poll using `X-Lumiverse-Capture-Lease: <transportToken>`. Poll well within the 45-second device lease. Commands are delivered once; a transport failure must not silently repeat a consent prompt.
- `POST /devices/:deviceId/displays`: publish an array of up to 16 `{ id, name, width, height, primary }` descriptors using the same private lease. IDs are 64 lowercase hex characters. The desktop publishes after registration and when topology changes. Removed displays cancel pending work targeting them. Older servers return 404 and the desktop retains picker support.
- `POST /devices/:deviceId/responses`: submit an approved media response or a denial/cancellation/unsupported/failure outcome, using the same lease header.
- `DELETE /devices/:deviceId`: disconnect, cancel requests, and discard retained media.
- `POST /devices/:deviceId/approval-status`: reply to a read-only `approval_status` command with `{ requestId, approval, source }` using the same private lease. Commands contain the extension/grant fingerprint, kind and destination, never a request to capture. Queries expire after ten seconds and recheck backend authorization before returning status.

The native session retries a disconnected transport every five seconds while
capture remains enabled. Each attempt revalidates the original account with
existing OAuth credentials, registers a fresh lease under the stable device
identity, and republishes display metadata. Recovery runs independently of
frontend reloads and tray rendering. Transport loss cancels unfinished capture;
reconnection never replays it or opens interactive authorization. Turning capture
off or changing instances stops the session and its retries.

An approved response has `{ requestId, outcome: 'approved', media: { mimeType, data, width, height, durationSeconds? } }`; `data` is standard padded base64. A non-approved response has `{ requestId, outcome }`. Error text from the native client is deliberately not relayed to extensions. Allowed MIME types are PNG/JPEG/WebP images and MP4/WebM video. Images are inspected with pixel limits; video currently receives container-signature and metadata checks, not complete codec/duration inspection. The native encoder must enforce the real clip duration and omit audio.

The broker retains assets only in bounded backend memory: 8 MiB/image, 128 MiB/video, 256 MiB globally. Release uploads only to the connected instance and authorized model destination. Windows display requests rely on the tray setup and current extension grants; picker approval identifies the instance and destination. Transport to a remote instance must use HTTPS. When request history is enabled, capture-backed requests retain text and parameters with media replaced by `[CAPTURE MEDIA OMITTED]`; successful response text is available with credential redaction. Opaque failure bodies remain unavailable. The history buffer is per-user, limited to 20 records in memory, and cleared when tracking is disabled. Already omitted bodies cannot be recovered. Model output may describe screen contents.

## Required native security boundary

Before advertising any capability, the native adapter must:

- Honor OS permissions and the native tray opt-in. Use the platform's picker when native source selection is needed.
- Identify the requesting extension, selected source, connected instance and exact model destination in setup or workflow controls. Treat server-provided labels as untrusted text.
- Require current capture and generation grants plus matching account and destination ownership. Selected Windows displays use these grants and tray opt-in directly; picker sources additionally require selection or a matching remembered native grant.
- Keep raw frames, encoder state, and replay storage native. Never send them through the shared frontend JavaScript realm.
- Show capture progress in the widget and keep a trusted stop control in Desktop. Turning the tray toggle off stops capture. Stop on cancellation, expiry, screen lock, logout, instance changes, source closure, or transport loss. Expired commands cannot authorize new capture.
- Enforce the command's byte/pixel/duration limits, no audio, and a bounded private recording buffer. Never start/rearm a replay buffer from a worker request.
- Connect through a native-only authenticated transport. Do not add privileged capture commands to existing wildcard-origin Tauri capabilities.

The server protocol cannot prove that a native producer honored its tray opt-in and platform permissions; those checks must be implemented and tested in the desktop adapter before capture capabilities are enabled. It does not defend against native malware, a compromised OS, or an upstream model retaining already-approved uploads.
