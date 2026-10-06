/**
 * Access policy: bearer tokens, kill switch, request rate limit.
 *
 * Two tokens, deliberately separate:
 *   LINKEDIN_VESSEL_MCP_TOKEN      - callers of /mcp and /manifest (agents, connectors)
 *   LINKEDIN_VESSEL_APPROVER_TOKEN - James only: /queue, /activity, approve, reject
 * A caller that can queue an action must not be able to approve it, so the
 * approver routes refuse to run when the two tokens are equal.
 *
 * Fail closed: an unset or short token disables the routes it guards.
 */

import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_TOKEN_LENGTH = 32;

export function isKilled(): boolean {
	const v = (process.env.LINKEDIN_VESSEL_KILL || "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type TokenRole = "mcp" | "approver";

const TOKEN_ENV: Record<TokenRole, string> = {
	mcp: "LINKEDIN_VESSEL_MCP_TOKEN",
	approver: "LINKEDIN_VESSEL_APPROVER_TOKEN",
};

function configuredToken(role: TokenRole): string | null {
	const t = (process.env[TOKEN_ENV[role]] || "").trim();
	if (t.length < MIN_TOKEN_LENGTH) return null;
	if (role === "approver" && t === (process.env[TOKEN_ENV.mcp] || "").trim()) return null;
	return t;
}

function digest(s: string): Buffer {
	return createHash("sha256").update(s, "utf8").digest();
}

/** Constant-time compare. Hashing first makes the compare length-independent. */
export function tokenMatches(presented: string, expected: string): boolean {
	return timingSafeEqual(digest(presented), digest(expected));
}

export type AuthResult = { ok: true } | { ok: false; status: 401 | 503; message: string };

export function authorize(req: Request, role: TokenRole): AuthResult {
	const expected = configuredToken(role);
	if (!expected) {
		return { ok: false, status: 503, message: `${TOKEN_ENV[role]} is not configured` };
	}
	const header = req.headers.get("authorization") || "";
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	if (!match || !tokenMatches(match[1].trim(), expected)) {
		return { ok: false, status: 401, message: "Unauthorized" };
	}
	return { ok: true };
}

// ── Request rate limit ─────────────────────────────────────────────
// Checked only after auth passes, with one window per role, so traffic that
// fails auth (or uses the MCP token) can never lock James out of approvals.

const WINDOW_MS = 60_000;
const windows: Record<TokenRole, { start: number; count: number }> = {
	mcp: { start: 0, count: 0 },
	approver: { start: 0, count: 0 },
};

export function requestAllowed(role: TokenRole, now = Date.now()): boolean {
	const max = Number.parseInt(process.env.LINKEDIN_VESSEL_REQ_PER_MIN || "60", 10) || 60;
	const w = windows[role];
	if (now - w.start >= WINDOW_MS) {
		w.start = now;
		w.count = 0;
	}
	w.count++;
	return w.count <= max;
}

export function resetRequestWindow(): void {
	for (const w of Object.values(windows)) {
		w.start = 0;
		w.count = 0;
	}
}
