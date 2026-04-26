/**
 * 8gent Code - User Policy Store (Turth)
 *
 * Scoped approval cache for the interactive permission prompt.
 * Four scopes: once, session, project (cwd-keyed), always (persisted).
 *
 * Design notes:
 *   - "once" is ephemeral and never stored beyond the current request
 *   - "session" lives in memory until the process exits
 *   - "project" is keyed by cwd and kept in memory (per TUI session)
 *   - "always" is written to ~/.8gent/user-policy.json (or EIGHT_DATA_DIR)
 *   - Every decision is appended to ~/.8gent/permissions-audit.jsonl
 *
 * Security posture (8SO):
 *   - Never default to "always": caller must explicitly pass scope
 *   - Deny short-circuits and is NEVER cached (always re-prompt)
 *   - Audit log entries include actor, timestamp, capability, scope, cwd
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type ApprovalScope = "once" | "session" | "project" | "always" | "deny";

export interface ApprovalDecision {
	/** true if the capability is allowed, false if denied */
	allowed: boolean;
	/** The scope under which this decision was stored */
	scope: ApprovalScope;
	/** Source: "cache" if resolved without prompting, "prompt" if freshly asked */
	source: "cache" | "prompt";
}

export interface AuditEntry {
	ts: string;
	actor: string;
	capability: string;
	scope: ApprovalScope;
	allowed: boolean;
	cwd: string;
}

interface PersistedPolicy {
	version: 1;
	always: Record<string, boolean>;
}

const DATA_DIR =
	process.env.EIGHT_DATA_DIR || path.join(os.homedir(), ".8gent");
const USER_POLICY_FILE = path.join(DATA_DIR, "user-policy.json");
const AUDIT_LOG_FILE = path.join(DATA_DIR, "permissions-audit.jsonl");

/** In-memory session cache. Cleared on process exit. */
const sessionCache = new Map<string, boolean>();
/** In-memory project cache, keyed by `cwd::capability`. */
const projectCache = new Map<string, boolean>();

let persistedLoaded = false;
let persisted: PersistedPolicy = { version: 1, always: {} };

function ensureDir(): void {
	if (!fs.existsSync(DATA_DIR)) {
		fs.mkdirSync(DATA_DIR, { recursive: true });
	}
}

function loadPersisted(): PersistedPolicy {
	if (persistedLoaded) return persisted;
	persistedLoaded = true;
	try {
		if (fs.existsSync(USER_POLICY_FILE)) {
			const raw = fs.readFileSync(USER_POLICY_FILE, "utf-8");
			const parsed = JSON.parse(raw) as PersistedPolicy;
			if (parsed && parsed.version === 1 && typeof parsed.always === "object") {
				persisted = parsed;
			}
		}
	} catch (err) {
		console.warn(`[user-policy] Failed to load ${USER_POLICY_FILE}: ${err}`);
	}
	return persisted;
}

function savePersisted(): void {
	try {
		ensureDir();
		fs.writeFileSync(USER_POLICY_FILE, JSON.stringify(persisted, null, 2));
	} catch (err) {
		console.warn(`[user-policy] Failed to save ${USER_POLICY_FILE}: ${err}`);
	}
}

function projectKey(capability: string, cwd: string): string {
	return `${cwd}::${capability}`;
}

function writeAudit(entry: AuditEntry): void {
	try {
		ensureDir();
		fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + "\n");
	} catch (err) {
		// Do not break permission flow on audit failure; log to stderr.
		console.warn(`[user-policy] audit write failed: ${err}`);
	}
}

/**
 * Look up a cached decision for a capability without prompting.
 * Returns null if no cached decision exists (caller should prompt).
 */
export function checkCapability(
	capability: string,
	cwd: string = process.cwd(),
): ApprovalDecision | null {
	// Session cache takes precedence over project cache only for the current process.
	if (sessionCache.has(capability)) {
		return {
			allowed: sessionCache.get(capability)!,
			scope: "session",
			source: "cache",
		};
	}
	const pKey = projectKey(capability, cwd);
	if (projectCache.has(pKey)) {
		return {
			allowed: projectCache.get(pKey)!,
			scope: "project",
			source: "cache",
		};
	}
	const p = loadPersisted();
	if (capability in p.always) {
		return { allowed: p.always[capability], scope: "always", source: "cache" };
	}
	return null;
}

/**
 * Persist a user decision at the chosen scope.
 * "once" is intentionally NOT cached. "deny" is never cached either - we always re-prompt.
 * Always writes an audit entry.
 */
export function recordDecision(
	capability: string,
	scope: ApprovalScope,
	options: { actor?: string; cwd?: string } = {},
): ApprovalDecision {
	const cwd = options.cwd ?? process.cwd();
	const actor = options.actor ?? "user";
	const allowed = scope !== "deny";

	switch (scope) {
		case "once":
			// No caching by design.
			break;
		case "session":
			sessionCache.set(capability, allowed);
			break;
		case "project":
			projectCache.set(projectKey(capability, cwd), allowed);
			break;
		case "always": {
			const p = loadPersisted();
			p.always[capability] = allowed;
			savePersisted();
			break;
		}
		case "deny":
			// Deny is never cached. Caller must re-prompt next time.
			break;
	}

	const entry: AuditEntry = {
		ts: new Date().toISOString(),
		actor,
		capability,
		scope,
		allowed,
		cwd,
	};
	writeAudit(entry);

	return { allowed, scope, source: "prompt" };
}

/** Clear the in-memory session cache. Called on TUI exit. */
export function clearSession(): void {
	sessionCache.clear();
	projectCache.clear();
}

/** Test hook: fully reset state including persisted cache. Only for unit tests. */
export function __resetForTest(): void {
	sessionCache.clear();
	projectCache.clear();
	persisted = { version: 1, always: {} };
	persistedLoaded = true;
}

/** Return the on-disk audit log path for external tooling. */
export function getAuditLogPath(): string {
	return AUDIT_LOG_FILE;
}

/** Return the on-disk user-policy path for external tooling. */
export function getUserPolicyPath(): string {
	return USER_POLICY_FILE;
}
