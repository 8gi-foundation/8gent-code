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
use std::process::{Command, Stdio};
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

    /// Resolve the repo root from CARGO_MANIFEST_DIR (compile-time) or env override.
    fn resolve_repo_root() -> std::path::PathBuf {
        // 1. Env override (set by user or build config)
        if let Ok(root) = std::env::var("EIGHT_REPO_ROOT") {
            let p = std::path::PathBuf::from(&root);
            if p.join("packages/eight/clui-bridge.ts").exists() {
                return p;
            }
        }

        // 2. Compile-time: CARGO_MANIFEST_DIR = apps/clui/src-tauri → go up 3 levels
        let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let from_manifest = manifest_dir
            .parent() // apps/clui
            .and_then(|p| p.parent()) // apps
            .and_then(|p| p.parent()); // repo root
        if let Some(root) = from_manifest {
            if root.join("packages/eight/clui-bridge.ts").exists() {
                return root.to_path_buf();
            }
        }

        // 3. Walk up from current_dir looking for packages/eight/clui-bridge.ts
        if let Ok(cwd) = std::env::current_dir() {
            let mut dir = cwd.as_path();
            for _ in 0..10 {
                if dir.join("packages/eight/clui-bridge.ts").exists() {
                    return dir.to_path_buf();
                }
                match dir.parent() {
                    Some(p) => dir = p,
                    None => break,
                }
            }
        }

        // 4. Fallback: cwd (will likely fail, but gives a useful error)
        std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
    }

    /// Find the bun binary — Tauri may not inherit the user's shell PATH.
    fn find_bun() -> String {
        // Check common locations for bun
        let candidates = [
            // Standard install locations
            format!("{}/.bun/bin/bun", std::env::var("HOME").unwrap_or_default()),
            "/usr/local/bin/bun".to_string(),
            "/opt/homebrew/bin/bun".to_string(),
            "bun".to_string(), // fallback to PATH
        ];
        for candidate in &candidates {
            if candidate == "bun" {
                return candidate.clone(); // final fallback
            }
            if std::path::Path::new(candidate).exists() {
                return candidate.clone();
            }
        }
        "bun".to_string()
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

        // Resolve the 8gent repo root reliably
        let repo_root = Self::resolve_repo_root();

        // Use the CLUI bridge which outputs NDJSON
        let agent_script = repo_root.join("packages/eight/clui-bridge.ts");
        if !agent_script.exists() {
            return Err(format!(
                "Agent bridge not found at {}. Repo root resolved to: {}",
                agent_script.display(),
                repo_root.display()
            ));
        }

        let work_dir = if cwd == "." {
            repo_root.to_string_lossy().to_string()
        } else {
            cwd.to_string()
        };

        let bun_path = Self::find_bun();

        // Spawn the Bun subprocess
        let mut child = Command::new(&bun_path)
            .args(["run", &agent_script.to_string_lossy()])
            .env("EIGHT_SESSION_ID", &session_id)
            .env("EIGHT_MODEL", model)
            .env("EIGHT_OUTPUT_FORMAT", "ndjson")
            .env("EIGHT_CLUI_MODE", "true")
            .env("EIGHT_REPO_ROOT", repo_root.to_string_lossy().as_ref())
            .current_dir(&work_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn agent (bun={}): {}", bun_path, e))?;

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
                                let _ = app_handle.emit_to("main", "agent_event", &payload);
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
                                let _ = app_handle.emit_to("main", "agent_event", &payload);
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
            let _ = app_handle.emit_to("main",
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
                            let _ = app_err.emit_to("main",
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
        let _ = app.emit_to("main",
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
