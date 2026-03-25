/// 8gent CLUI library crate.
///
/// Re-exports the run function for Tauri's mobile entry point and
/// provides shared modules used by both lib and bin targets.

mod agent;
mod permissions;

use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager,
    menu::{Menu, MenuItem, Submenu, PredefinedMenuItem},
    tray::TrayIconBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState, Builder as GlobalShortcutBuilder};
use std::process::Command;

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

/// Query the daemon for active session count via its REST endpoint.
fn get_session_count() -> usize {
    let output = Command::new("curl")
        .args(["-s", "--max-time", "1", "http://127.0.0.1:18789/status"])
        .output();

    match output {
        Ok(o) if o.status.success() => {
            let body = String::from_utf8_lossy(&o.stdout);
            // Parse JSON: look for "sessions": N
            if let Some(pos) = body.find("\"sessions\":") {
                let rest = &body[pos + 11..];
                let num_str: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                num_str.parse().unwrap_or(0)
            } else {
                0
            }
        }
        _ => 0,
    }
}

/// Check if the daemon is running.
fn is_daemon_running() -> bool {
    Command::new("curl")
        .args(["-s", "--max-time", "1", "http://127.0.0.1:18789/health"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // -- Status section --
    let daemon_up = is_daemon_running();
    let sessions = if daemon_up { get_session_count() } else { 0 };
    let status_label = if daemon_up {
        format!("Eight Daemon: Online ({} session{})", sessions, if sessions == 1 { "" } else { "s" })
    } else {
        "Eight Daemon: Offline".to_string()
    };

    let status = MenuItem::with_id(app, "status", &status_label, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;

    // -- Actions --
    let show_hide = MenuItem::with_id(app, "show_hide", "Show/Hide (Alt+Space)", true, None::<&str>)?;
    let new_session = MenuItem::with_id(app, "new_session", "New Session", true, None::<&str>)?;
    let open_terminal = MenuItem::with_id(app, "open_terminal", "Open TUI in Terminal", true, None::<&str>)?;
    let sep2 = PredefinedMenuItem::separator(app)?;

    // -- Resource management submenu --
    let suggest_quit = MenuItem::with_id(app, "suggest_quit", "Suggest Apps to Quit...", true, None::<&str>)?;
    let manage_safe_list = MenuItem::with_id(app, "manage_safe_list", "Manage Safe List...", true, None::<&str>)?;
    let resources_menu = Submenu::with_items(
        app,
        "Resource Manager",
        true,
        &[&suggest_quit, &manage_safe_list],
    )?;

    // -- Settings submenu --
    let daemon_toggle = if daemon_up {
        MenuItem::with_id(app, "daemon_stop", "Stop Daemon", true, None::<&str>)?
    } else {
        MenuItem::with_id(app, "daemon_start", "Start Daemon", true, None::<&str>)?
    };
    let view_logs = MenuItem::with_id(app, "view_logs", "View Daemon Logs", true, None::<&str>)?;
    let open_config = MenuItem::with_id(app, "open_config", "Open Config Dir", true, None::<&str>)?;
    let settings_menu = Submenu::with_items(
        app,
        "Settings",
        true,
        &[&daemon_toggle, &view_logs, &open_config],
    )?;

    let sep3 = PredefinedMenuItem::separator(app)?;

    // -- Info --
    let version = MenuItem::with_id(app, "version", "8gent Code v1.0.0", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit 8gent CLUI", true, None::<&str>)?;

    let menu = Menu::with_items(
        app,
        &[
            &status,
            &sep1,
            &show_hide,
            &new_session,
            &open_terminal,
            &sep2,
            &resources_menu,
            &settings_menu,
            &sep3,
            &version,
            &quit,
        ],
    )?;

    let _tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip(if daemon_up {
            format!("8gent - {} session{}", sessions, if sessions == 1 { "" } else { "s" })
        } else {
            "8gent - Daemon offline".to_string()
        }.as_str())
        .on_menu_event(move |app, event| {
            match event.id.as_ref() {
                "show_hide" => toggle_window(app),
                "new_session" => {
                    let _ = app.emit("tray_new_session", ());
                }
                "open_terminal" => {
                    // Open a new terminal window running 8gent TUI
                    let _ = Command::new("open")
                        .args(["-a", "Terminal"])
                        .spawn();
                    // Small delay then send the command
                    let _ = Command::new("osascript")
                        .args([
                            "-e",
                            "tell application \"Terminal\" to do script \"8gent\"",
                        ])
                        .spawn();
                }
                "suggest_quit" => {
                    let _ = app.emit("tray_suggest_quit", ());
                }
                "manage_safe_list" => {
                    let _ = app.emit("tray_manage_safe_list", ());
                }
                "daemon_start" => {
                    let _ = Command::new("bun")
                        .args(["run", "daemon"])
                        .current_dir(
                            std::env::var("EIGHT_CODE_DIR")
                                .unwrap_or_else(|_| ".".to_string())
                        )
                        .spawn();
                    let _ = app.emit("tray_daemon_started", ());
                }
                "daemon_stop" => {
                    let _ = Command::new("curl")
                        .args(["-s", "-X", "POST", "http://127.0.0.1:18789/shutdown"])
                        .spawn();
                    let _ = app.emit("tray_daemon_stopped", ());
                }
                "view_logs" => {
                    let log_path = std::path::PathBuf::from(
                            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
                        ).join(".8gent/daemon.log");
                    let _ = Command::new("open")
                        .arg("-a")
                        .arg("Console")
                        .arg(log_path)
                        .spawn();
                }
                "open_config" => {
                    let config_dir = std::path::PathBuf::from(
                            std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string())
                        ).join(".8gent");
                    let _ = Command::new("open")
                        .arg(config_dir)
                        .spawn();
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
