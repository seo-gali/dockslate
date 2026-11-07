use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

const ID: &str = "dockslate";

fn menu(app: &AppHandle, english: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let open = MenuItem::with_id(app, "tray-open", if english { "Open DockSlate" } else { "열기" }, true, None::<&str>)?;
    let containers = MenuItem::with_id(app, "tray-containers", if english { "Containers" } else { "컨테이너" }, true, None::<&str>)?;
    let images = MenuItem::with_id(app, "tray-images", if english { "Images" } else { "이미지" }, true, None::<&str>)?;
    let navigation_separator = PredefinedMenuItem::separator(app)?;
    let refresh = MenuItem::with_id(app, "tray-refresh", if english { "Refresh all" } else { "전체 새로고침" }, true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "tray-settings", if english { "Settings" } else { "설정" }, true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "tray-quit", if english { "Quit DockSlate" } else { "완전 종료" }, true, None::<&str>)?;
    Menu::with_items(app, &[&open, &containers, &images, &navigation_separator, &refresh, &settings, &separator, &quit])
}

pub fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()) {
            eprintln!("DockSlate tray window: {error}");
        }
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if crate::installer_setup_mode() {
        return Ok(());
    }
    let icon = app.default_window_icon().ok_or("DockSlate tray icon is unavailable.")?.clone();
    TrayIconBuilder::with_id(ID)
        .icon(icon)
        .tooltip("DockSlate")
        .menu(&menu(app.handle(), false)?)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_window(app),
            "tray-containers" | "tray-images" | "tray-refresh" | "tray-settings" => {
                show_window(app);
                if let Err(error) = app.emit("tray-action", event.id.as_ref().trim_start_matches("tray-")) {
                    eprintln!("DockSlate tray action: {error}");
                }
            }
            "tray-quit" => crate::request_exit(app, 0),
            _ => (),
        })
        .build(app)?;
    Ok(())
}

pub fn set_language(app: &AppHandle, language: &str) -> Result<(), String> {
    if !matches!(language, "ko" | "en") {
        return Err("지원하지 않는 언어입니다.".into());
    }
    if let Some(tray) = app.tray_by_id(ID) {
        tray.set_menu(Some(menu(app, language == "en").map_err(|error| error.to_string())?))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
