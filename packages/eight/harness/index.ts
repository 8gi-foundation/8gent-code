/**
 * Harness Isolation Module
 *
 * Brain/hands architecture with immutable audit logging.
 *
 *   Session  - Append-only JSONL event log with SHA-256 chain
 *   Harness  - Stateless reasoning loop (crash-restartable)
 *   Sandbox  - Replaceable tool execution (credentials never enter)
 *   Vault    - Credential injection at the sandbox boundary
 *   Audit    - CLI for inspecting and verifying session logs
 *
 * Issues: #1402, #1403
 */

// Types (the contract)
export type {
  AuditEntry,
  AuditEntryType,
  Session,
  Sandbox,
  ToolHandler,
  CredentialVault,
  HarnessConfig,
  HarnessAction,
  HarnessRunResult,
} from "./types";

// Session (append-only JSONL with checksum chain)
export {
  createSession,
  openSession,
  listSessions,
  getSessionsDir,
  computeHash,
} from "./session";

// Harness (stateless loop)
export { runHarness } from "./harness";

// Sandbox (tool execution)
export { createSandbox, type MutableSandbox } from "./sandbox";

// Vault (credential management)
export { createVault } from "./vault";

// Audit CLI
export { runAuditCLI } from "./audit-cli";
