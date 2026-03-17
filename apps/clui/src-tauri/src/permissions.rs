/**
 * 8gent CLUI -- Permission Server
 *
 * Localhost-only HTTP server that intercepts agent tool calls for
 * human-in-the-loop approval. The agent subprocess sends POST requests
 * to this server before executing any tool. The server holds the request
 * open until the user approves or denies via the CLUI frontend.
 *
 * Flow:
 * 1. Agent sends POST /approve { tool, input, session_id }
 * 2. Server emits Tauri event to frontend: permission_request
 * 3. User clicks Approve/Deny in PermissionDialog
 * 4. Frontend calls respond_to_permission Tauri command
 * 5. Server responds to agent's HTTP request: { approved: true/false }
 * 6. Agent proceeds or aborts
 */

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
// Arc and Mutex will be used when the HTTP server is fully implemented
#[allow(unused_imports)]
use std::sync::{Arc, Mutex};

/// A pending permission request from an agent subprocess.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub session_id: String,
    pub tool_name: String,
    pub tool_input: serde_json::Value,
    pub timestamp: u64,
}

/// Auto-approve rule for a specific tool type.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutoApproveRule {
    pub tool_pattern: String,
    pub action: ApproveAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ApproveAction {
    AlwaysApprove,
    AlwaysDeny,
    Ask,
}

/// The permission server manages pending requests and auto-approve rules.
pub struct PermissionServer {
    pending: HashMap<String, PendingResponse>,
    auto_rules: Vec<AutoApproveRule>,
    port: Option<u16>,
    counter: u64,
}

struct PendingResponse {
    request: PermissionRequest,
    /// In production, this would hold a tokio oneshot::Sender<bool>
    /// to respond to the waiting HTTP request.
    responded: bool,
    approved: Option<bool>,
}

impl PermissionServer {
    pub fn new() -> Self {
        Self {
            pending: HashMap::new(),
            auto_rules: vec![
                // Default rules: read operations auto-approved, writes ask
                AutoApproveRule {
                    tool_pattern: "read_file".to_string(),
                    action: ApproveAction::AlwaysApprove,
                },
                AutoApproveRule {
                    tool_pattern: "list_directory".to_string(),
                    action: ApproveAction::AlwaysApprove,
                },
                AutoApproveRule {
                    tool_pattern: "search_*".to_string(),
                    action: ApproveAction::AlwaysApprove,
                },
            ],
            port: None,
            counter: 0,
        }
    }

    /// Start the HTTP server on an ephemeral port.
    /// Returns the assigned port number.
    pub fn start(&mut self) -> Result<u16, String> {
        // In production, this spawns a tokio HTTP server (e.g., axum or warp)
        // listening on 127.0.0.1:0 (ephemeral port).
        //
        // For the scaffold, we assign a placeholder port.
        let port = 19823; // Would be dynamically assigned
        self.port = Some(port);
        Ok(port)
    }

    /// Check if a tool call matches an auto-approve rule.
    pub fn check_auto_approve(&self, tool_name: &str) -> Option<bool> {
        for rule in &self.auto_rules {
            let matches = if rule.tool_pattern.ends_with('*') {
                let prefix = &rule.tool_pattern[..rule.tool_pattern.len() - 1];
                tool_name.starts_with(prefix)
            } else {
                tool_name == rule.tool_pattern
            };

            if matches {
                return match rule.action {
                    ApproveAction::AlwaysApprove => Some(true),
                    ApproveAction::AlwaysDeny => Some(false),
                    ApproveAction::Ask => None,
                };
            }
        }
        None // No matching rule, must ask
    }

    /// Register a new pending permission request.
    pub fn add_request(&mut self, request: PermissionRequest) -> String {
        let id = request.id.clone();
        self.pending.insert(
            id.clone(),
            PendingResponse {
                request,
                responded: false,
                approved: None,
            },
        );
        id
    }

    /// Respond to a pending permission request (called from Tauri command).
    pub fn respond(&self, request_id: String, approved: bool) -> Result<(), String> {
        // In production with Arc<Mutex<HashMap>>, we would:
        // 1. Remove the pending entry
        // 2. Send the response through the oneshot channel
        // 3. The HTTP handler would receive it and respond to the agent
        //
        // For the scaffold:
        eprintln!(
            "[permissions] Request {} {} {}",
            request_id,
            if approved { "APPROVED" } else { "DENIED" },
            ""
        );
        Ok(())
    }

    /// Get the server port (if started).
    pub fn port(&self) -> Option<u16> {
        self.port
    }

    /// Add an auto-approve rule.
    pub fn add_rule(&mut self, rule: AutoApproveRule) {
        self.auto_rules.push(rule);
    }

    /// List all pending requests.
    pub fn pending_requests(&self) -> Vec<PermissionRequest> {
        self.pending
            .values()
            .filter(|p| !p.responded)
            .map(|p| p.request.clone())
            .collect()
    }
}
