/**
 * Structured Audit Trail for NemoClaw (#989)
 *
 * Append-only JSONL audit log per session with SHA-256 integrity checksums.
 * Redacts common secret patterns before writing.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ============================================
// Types
// ============================================

export interface AuditEvent {
  timestamp: string;
  agentId: string;
  action: string;
  target: string;
  decision: "allow" | "block" | "require_approval";
  reason?: string;
  toolName?: string;
}

// ============================================
// Constants
// ============================================

const BASE_DIR = path.join(
  process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent"),
  "audit"
);
const SESSIONS_DIR = path.join(BASE_DIR, "sessions");
const CHECKSUMS_PATH = path.join(BASE_DIR, "checksums.json");

/** Patterns that look like secrets - redacted before logging */
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /\b[A-Za-z0-9]{32,}\b/g,             // long opaque tokens
  /sk-[A-Za-z0-9]{20,}/g,              // OpenAI-style keys
  /ghp_[A-Za-z0-9]{36}/g,              // GitHub PATs
  /xox[baprs]-[A-Za-z0-9\-]{10,}/g,    // Slack tokens
  /AKIA[0-9A-Z]{16}/g,                 // AWS access key IDs
];

// ============================================
// Helpers
// ============================================

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function loadChecksums(): Record<string, string> {
  try {
    if (fs.existsSync(CHECKSUMS_PATH)) {
      return JSON.parse(fs.readFileSync(CHECKSUMS_PATH, "utf-8"));
    }
  } catch { /* fresh start */ }
  return {};
}

function saveChecksums(checksums: Record<string, string>): void {
  ensureDir(BASE_DIR);
  fs.writeFileSync(CHECKSUMS_PATH, JSON.stringify(checksums, null, 2));
}

// ============================================
// AuditTrail
// ============================================

export class AuditTrail {
  private sessionId: string;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  /** Append an event to the session JSONL log. */
  append(event: AuditEvent): void {
    try {
      ensureDir(SESSIONS_DIR);
      const filePath = path.join(SESSIONS_DIR, `${this.sessionId}.jsonl`);
      const isNew = !fs.existsSync(filePath);

      const safe: AuditEvent = {
        ...event,
        target: redact(event.target),
        reason: event.reason ? redact(event.reason) : undefined,
      };

      fs.appendFileSync(filePath, JSON.stringify(safe) + "\n");

      // Compute and store checksum on first write
      if (isNew) this.updateChecksum();
    } catch {
      // Audit must never block execution
    }
  }

  /** Verify the session log has not been tampered with. */
  verify(): { valid: boolean; reason: string } {
    const filePath = path.join(SESSIONS_DIR, `${this.sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) {
      return { valid: false, reason: "Session log not found" };
    }

    const checksums = loadChecksums();
    const stored = checksums[this.sessionId];
    if (!stored) {
      return { valid: false, reason: "No stored checksum for session" };
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const current = sha256(content);
    if (current !== stored) {
      return { valid: false, reason: `Checksum mismatch: expected ${stored.slice(0, 12)}..., got ${current.slice(0, 12)}...` };
    }

    return { valid: true, reason: "Checksum verified" };
  }

  /** Recompute and store checksum for the current session log. */
  updateChecksum(): void {
    try {
      const filePath = path.join(SESSIONS_DIR, `${this.sessionId}.jsonl`);
      if (!fs.existsSync(filePath)) return;

      const content = fs.readFileSync(filePath, "utf-8");
      const checksums = loadChecksums();
      checksums[this.sessionId] = sha256(content);
      saveChecksums(checksums);
    } catch {
      // Silent
    }
  }
}
