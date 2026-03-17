/**
 * 8gent CLUI — Agent Session Manager
 *
 * Manages Bun child processes, one per session tab.
 * Each process runs `bun run packages/eight/index.ts` and communicates
 * via NDJSON over stdout. Events are forwarded to the React frontend
 * through Tauri's event system.
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// Shared handle to a child process's stdin.
type SharedStdin = Arc<Mutex<Option<std::process::ChildStdin>>>;

/// A single agent session backed by a Bun subprocess.
pub struct AgentSession {
    pub id: String,
    pub model: String,
    pub cwd: String,
    stdin: SharedStdin,
    child_pid: Option<u32>,
}

/// NDJSON event emitted by the 8gent engine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

/// Tauri event payload sent to the React frontend.
#[derive(Debug, Clone, Serialize)]
pub struct SessionEvent {
    pub session_id: String,
    pub event: AgentEvent,
}

/// Manages all active agent sessions.
pub struct AgentManager {
    sessions: HashMap<String, AgentSession>,
    counter: u64,
}

impl AgentManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            counter: 0,
        }
    }

    /// Create a new agent session and spawn the Bun subprocess.
    pub fn create_session(
        &mut self,
        app: &AppHandle,
        model: &str,
        cwd: &str,
    ) -> Result<String, String> {
        self.counter += 1;
        let session_id = format!("session_{}", self.counter);

        // Resolve the 8gent repo root (go up from apps/clui)
        let repo_root = std::env::current_dir()
            .unwrap_or_else(|_| std::path::PathBuf::from("."));

        // Use the CLUI bridge which outputs NDJSON
        let agent_script = if repo_root.join("packages/eight/clui-bridge.ts").exists() {
            repo_root.join("packages/eight/clui-bridge.ts")
        } else if repo_root.join("packages/eight/index.ts").exists() {
            repo_root.join("packages/eight/index.ts")
        } else {
            std::path::PathBuf::from("packages/eight/clui-bridge.ts")
        };

        let work_dir = if cwd == "." {
            repo_root.to_string_lossy().to_string()
        } else {
            cwd.to_string()
        };

        // Spawn the Bun subprocess
        let mut child = Command::new("bun")
            .args(["run", &agent_script.to_string_lossy()])
            .env("EIGHT_SESSION_ID", &session_id)
            .env("EIGHT_MODEL", model)
            .env("EIGHT_OUTPUT_FORMAT", "ndjson")
            .env("EIGHT_CLUI_MODE", "true")
            .current_dir(&work_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn agent: {}", e))?;

        let child_pid = child.id();

        // Extract stdin into a shared handle
        let stdin_handle: SharedStdin = Arc::new(Mutex::new(child.stdin.take()));

        // Extract stdout for the NDJSON reader thread
        let stdout = child.stdout.take()
            .ok_or_else(|| "Failed to capture agent stdout".to_string())?;

        // Extract stderr for logging
        let stderr = child.stderr.take();

        let session = AgentSession {
            id: session_id.clone(),
            model: model.to_string(),
            cwd: work_dir.clone(),
            stdin: stdin_handle,
            child_pid: Some(child_pid),
        };

        // Spawn thread to read NDJSON events from stdout
        let app_handle = app.clone();
        let sid = session_id.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        // Try to parse as NDJSON
                        match serde_json::from_str::<AgentEvent>(&line) {
                            Ok(event) => {
                                let payload = SessionEvent {
                                    session_id: sid.clone(),
                                    event,
                                };
                                let _ = app_handle.emit("agent_event", &payload);
                            }
                            Err(_) => {
                                // Not valid JSON — treat as plain text output
                                let payload = SessionEvent {
                                    session_id: sid.clone(),
                                    event: AgentEvent {
                                        event_type: "text".to_string(),
                                        data: serde_json::json!({"content": line}),
                                    },
                                };
                                let _ = app_handle.emit("agent_event", &payload);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[session {}] stdout read error: {}", sid, e);
                        break;
                    }
                    _ => {} // empty line, skip
                }
            }

            // Process has ended
            let _ = app_handle.emit(
                "agent_event",
                &SessionEvent {
                    session_id: sid.clone(),
                    event: AgentEvent {
                        event_type: "session_end".to_string(),
                        data: serde_json::json!({"reason": "process exited"}),
                    },
                },
            );
        });

        // Spawn thread to read stderr (for debugging)
        if let Some(stderr) = stderr {
            let sid_err = session_id.clone();
            let app_err = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    if let Ok(line) = line {
                        if !line.trim().is_empty() {
                            eprintln!("[session {} stderr] {}", sid_err, line);
                            // Forward stderr as system messages
                            let _ = app_err.emit(
                                "agent_event",
                                &SessionEvent {
                                    session_id: sid_err.clone(),
                                    event: AgentEvent {
                                        event_type: "stderr".to_string(),
                                        data: serde_json::json!({"content": line}),
                                    },
                                },
                            );
                        }
                    }
                }
            });
        }

        self.sessions.insert(session_id.clone(), session);

        // Notify frontend that session is ready
        let _ = app.emit(
            "agent_event",
            &SessionEvent {
                session_id: session_id.clone(),
                event: AgentEvent {
                    event_type: "session_start".to_string(),
                    data: serde_json::json!({
                        "model": model,
                        "cwd": work_dir,
                    }),
                },
            },
        );

        Ok(session_id)
    }

    /// Send input text to an agent session's stdin.
    pub fn send_input(&self, session_id: &str, content: &str) -> Result<(), String> {
        let session = self
            .sessions
            .get(session_id)
            .ok_or_else(|| format!("Session {} not found", session_id))?;

        let mut stdin_lock = session.stdin.lock()
            .map_err(|e| format!("Failed to lock stdin: {}", e))?;

        if let Some(ref mut stdin) = *stdin_lock {
            stdin
                .write_all(format!("{}\n", content).as_bytes())
                .map_err(|e| format!("Failed to write to stdin: {}", e))?;
            stdin
                .flush()
                .map_err(|e| format!("Failed to flush stdin: {}", e))?;
            Ok(())
        } else {
            Err(format!("Session {} stdin is closed", session_id))
        }
    }

    /// Close a session and kill its subprocess.
    pub fn close_session(&mut self, session_id: &str) -> Result<(), String> {
        if let Some(session) = self.sessions.remove(session_id) {
            // Close stdin first (signals EOF to the agent)
            if let Ok(mut stdin_lock) = session.stdin.lock() {
                *stdin_lock = None;
            }
            // Kill the process
            if let Some(pid) = session.child_pid {
                unsafe {
                    libc::kill(pid as i32, libc::SIGTERM);
                }
            }
            Ok(())
        } else {
            Err(format!("Session {} not found", session_id))
        }
    }

    /// List all active session IDs.
    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.keys().cloned().collect()
    }
}
