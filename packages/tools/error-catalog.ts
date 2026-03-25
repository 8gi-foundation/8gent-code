/**
 * Centralized Error Code Registry for 8gent
 *
 * Codes E001-E999 covering agent, tools, memory, permissions, network,
 * kernel, and provider subsystems. Lookup by code or keyword search.
 */

export interface ErrorEntry {
  code: string;
  category: string;
  description: string;
  fix: string;
}

const catalog: ErrorEntry[] = [
  // --- Agent Core (E001-E099) ---
  { code: "E001", category: "agent", description: "Agent loop exceeded max iterations", fix: "Increase maxIterations in agent config or simplify the task." },
  { code: "E002", category: "agent", description: "Agent aborted by user (ESC)", fix: "No action needed - user-initiated abort." },
  { code: "E003", category: "agent", description: "Checkpoint restore failed", fix: "Delete corrupted checkpoint in .8gent/checkpoints/ and restart session." },
  { code: "E004", category: "agent", description: "System prompt injection too large", fix: "Reduce USER_CONTEXT_SEGMENT size or trim memory injection." },
  { code: "E005", category: "agent", description: "Session file corrupted or unreadable", fix: "Remove the session file from .8gent/sessions/ and start fresh." },

  // --- Tools (E100-E199) ---
  { code: "E100", category: "tools", description: "Tool not found in registry", fix: "Check tool name spelling. Run tools.list() to see available tools." },
  { code: "E101", category: "tools", description: "Tool execution timed out", fix: "Increase timeout or break the operation into smaller steps." },
  { code: "E102", category: "tools", description: "Tool returned invalid output schema", fix: "Verify tool output matches its declared schema in tools.ts." },
  { code: "E103", category: "tools", description: "File operation denied by sandbox", fix: "Check NemoClaw policy rules. The path may be outside allowed directories." },
  { code: "E104", category: "tools", description: "Shell command blocked by policy engine", fix: "Review packages/permissions/policy-engine.ts deny rules for this command." },

  // --- Memory (E200-E299) ---
  { code: "E200", category: "memory", description: "SQLite database locked", fix: "Close other processes using the DB. Check for stale .8gent/memory.db-wal files." },
  { code: "E201", category: "memory", description: "FTS5 index corrupted", fix: "Run 'INSERT INTO memories_fts(memories_fts) VALUES(\"rebuild\")' to rebuild the index." },
  { code: "E202", category: "memory", description: "Memory consolidation job failed", fix: "Check lease-based job queue for stuck leases. Clear expired leases and retry." },
  { code: "E203", category: "memory", description: "Embedding generation failed", fix: "Verify Ollama is running and the embedding model is pulled." },
  { code: "E204", category: "memory", description: "Memory contradiction detected", fix: "Review conflicting memories and manually resolve or let consolidation handle it." },

  // --- Permissions (E300-E399) ---
  { code: "E300", category: "permissions", description: "Action denied by NemoClaw policy", fix: "Check policy YAML in packages/permissions/. Add an allow rule or use approval gate." },
  { code: "E301", category: "permissions", description: "Approval gate timed out waiting for user", fix: "Respond to the approval prompt, or enable headless/infinite mode." },
  { code: "E302", category: "permissions", description: "Policy file parse error", fix: "Validate YAML syntax in the policy file. Check for tabs vs spaces." },

  // --- Network / Providers (E400-E499) ---
  { code: "E400", category: "network", description: "Ollama connection refused", fix: "Start Ollama with 'ollama serve'. Verify it is on port 11434." },
  { code: "E401", category: "network", description: "OpenRouter API key missing or invalid", fix: "Set OPENROUTER_API_KEY in environment or .env file." },
  { code: "E402", category: "network", description: "Model not found on provider", fix: "Check model name. Run 'ollama list' for local or check OpenRouter docs for cloud." },
  { code: "E403", category: "network", description: "Rate limited by provider", fix: "Wait and retry. Consider switching to a local model via task router." },
  { code: "E404", category: "network", description: "Provider response stream interrupted", fix: "Check network connection. The provider may have timed out - retry the request." },
  { code: "E405", category: "network", description: "WebSocket connection to daemon lost", fix: "Check Fly.io status. Reconnect will happen automatically on next request." },

  // --- Kernel / Training (E500-E599) ---
  { code: "E500", category: "kernel", description: "Training proxy failed to start", fix: "Check config/training-proxy.yaml. Ensure training is enabled in .8gent/config.json." },
  { code: "E501", category: "kernel", description: "GRPO batch collection incomplete", fix: "Verify judge model is reachable. Check kernel logs in .8gent/kernel/." },
  { code: "E502", category: "kernel", description: "Checkpoint validation failed - auto-rollback triggered", fix: "Review training logs. The model may need more data before next training run." },
  { code: "E503", category: "kernel", description: "LoRA merge conflict", fix: "Only one LoRA can be active. Deactivate the current one before merging." },

  // --- TUI / UI (E600-E699) ---
  { code: "E600", category: "tui", description: "Terminal too narrow for layout", fix: "Widen the terminal to at least 80 columns." },
  { code: "E601", category: "tui", description: "Ink render crash - invalid JSX tree", fix: "Check component props. A primitive may have received an unexpected child type." },
  { code: "E602", category: "tui", description: "Theme token not found", fix: "Use tokens from apps/tui/src/theme/tokens.ts. Do not use raw color strings." },

  // --- Orchestration (E700-E799) ---
  { code: "E700", category: "orchestration", description: "Worktree pool exhausted (max 4)", fix: "Wait for a running worktree to finish, or cancel one with WorktreePool.release()." },
  { code: "E701", category: "orchestration", description: "Worktree filesystem messaging failed", fix: "Check .8gent/worktrees/ for stale lock files and remove them." },
  { code: "E702", category: "orchestration", description: "Sub-agent delegation timed out", fix: "Increase delegation timeout or simplify the delegated task." },

  // --- Browser (E800-E899) ---
  { code: "E800", category: "browser", description: "Fetch request failed", fix: "Check URL validity and network connectivity. The site may be blocking bots." },
  { code: "E801", category: "browser", description: "HTML-to-text extraction returned empty", fix: "The page may require JavaScript. Try a different URL or cached version." },
  { code: "E802", category: "browser", description: "DuckDuckGo search returned no results", fix: "Simplify search query or try different keywords." },

  // --- Daemon (E900-E999) ---
  { code: "E900", category: "daemon", description: "Daemon health check failed", fix: "Check eight-vessel.fly.dev status. Run 'fly status' for deployment info." },
  { code: "E901", category: "daemon", description: "Session auth token expired", fix: "Re-authenticate with the daemon. Tokens expire after 24h by default." },
  { code: "E902", category: "daemon", description: "Agent pool capacity exceeded on daemon", fix: "Wait for slots to free up, or scale the Fly.io machine." },
];

/** Lookup a single error by its code (e.g. "E200"). */
export function lookupByCode(code: string): ErrorEntry | undefined {
  return catalog.find((e) => e.code === code.toUpperCase());
}

/** Search errors by keyword across description, fix, and category. Case-insensitive. */
export function searchErrors(keyword: string): ErrorEntry[] {
  const kw = keyword.toLowerCase();
  return catalog.filter(
    (e) =>
      e.description.toLowerCase().includes(kw) ||
      e.fix.toLowerCase().includes(kw) ||
      e.category.toLowerCase().includes(kw) ||
      e.code.toLowerCase().includes(kw),
  );
}

/** List all errors in a category. */
export function listCategory(category: string): ErrorEntry[] {
  return catalog.filter((e) => e.category === category.toLowerCase());
}

/** Get all registered categories. */
export function getCategories(): string[] {
  return [...new Set(catalog.map((e) => e.category))];
}

/** Get the full catalog. */
export function getAllErrors(): ErrorEntry[] {
  return [...catalog];
}
