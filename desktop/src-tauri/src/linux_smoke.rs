//! Explicit, offline release-check fixture. It exercises real WebKit input;
//! it does not claim to qualify the chat frontend or proprietary GPU drivers.
pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if !cfg!(target_os = "linux") || std::env::var("LUMIVERSE_DESKTOP_SMOKE").as_deref() != Ok("1")
    {
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "linux-smoke",
        tauri::WebviewUrl::App("linux-smoke.html".into()),
    )
    .title("Lumiverse Desktop Smoke Loading")
    .inner_size(640.0, 480.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn desktop_smoke_complete(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "linux-smoke"
        || std::env::var("LUMIVERSE_DESKTOP_SMOKE").as_deref() != Ok("1")
    {
        return Err("The offline smoke fixture is not enabled.".into());
    }
    eprintln!("[desktop-smoke] trusted click, typing, scrolling and host URL dispatch passed");
    Ok(())
}
