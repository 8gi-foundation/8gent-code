/// 8gent CLUI library crate.
///
/// Re-exports the run function for Tauri's mobile entry point and
/// provides shared modules used by both lib and bin targets.

mod agent;
mod permissions;

use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState, Builder as GlobalShortcutBuilder};

/// Application state shared across commands and event handlers.
struct AppState {
    agent_manager: Mutex<agent::AgentManager>,
    permission_server: Mutex<permissions::PermissionServer>,
}

// -- Tauri Commands --

#[tauri::command]
fn create_session(
    state: tauri::State<'_, AppState>,
    app: AppHandle,
    model: Option<String>,
    cwd: Option<String>,
) -> Result<String, String> {
    let mut manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    let session_id = manager.create_session(
        &app,
        model.as_deref().unwrap_or("qwen3.5"),
        cwd.as_deref().unwrap_or("."),
    )?;
    Ok(session_id)
}

#[tauri::command]
fn send_to_agent(
    state: tauri::State<'_, AppState>,
    session_id: String,
    content: String,
) -> Result<(), String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.send_input(&session_id, &content)
}

#[tauri::command]
fn close_session(
    state: tauri::State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let mut manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    manager.close_session(&session_id)
}

#[tauri::command]
fn list_sessions(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let manager = state.agent_manager.lock().map_err(|e| e.to_string())?;
    Ok(manager.list_sessions())
}

#[tauri::command]
fn respond_to_permission(
    state: tauri::State<'_, AppState>,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    let server = state.permission_server.lock().map_err(|e| e.to_string())?;
    server.respond(request_id, approved)
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide (Alt+Space)", true, None::<&str>)?;
    let new_session = MenuItem::with_id(app, "new_session", "New Session", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit 8gent CLUI", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_hide, &new_session, &quit])?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("8gent CLUI")
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show_hide" => toggle_window(app),
                "new_session" => {
                    let _ = app.emit("tray_new_session", ());
                }
                "quit" => {
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                toggle_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

// Global shortcut is handled via the plugin builder in run()

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(
            GlobalShortcutBuilder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let shortcut_str = format!("{:?}", shortcut);
                        if shortcut_str.contains("Space") {
                            toggle_window(app);
                        }
                    }
                })
                .build(),
        )
        .manage(AppState {
            agent_manager: Mutex::new(agent::AgentManager::new()),
            permission_server: Mutex::new(permissions::PermissionServer::new()),
        })
        .invoke_handler(tauri::generate_handler![
            create_session,
            send_to_agent,
            close_session,
            list_sessions,
            respond_to_permission,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            setup_tray(&handle)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running 8gent CLUI");
}
