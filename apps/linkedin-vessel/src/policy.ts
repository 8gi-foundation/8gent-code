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
	const t = process.env[TOKEN_ENV[role]] || "";
	if (t.length < MIN_TOKEN_LENGTH) return null;
	if (role === "approver" && t === (process.env[TOKEN_ENV.mcp] || "")) return null;
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

// ── Request rate limit (single-tenant service, one fixed window) ──────

const WINDOW_MS = 60_000;
let windowStart = 0;
let windowCount = 0;

export function requestAllowed(now = Date.now()): boolean {
	const max = Number.parseInt(process.env.LINKEDIN_VESSEL_REQ_PER_MIN || "60", 10) || 60;
	if (now - windowStart >= WINDOW_MS) {
		windowStart = now;
		windowCount = 0;
	}
	windowCount++;
	return windowCount <= max;
}

export function resetRequestWindow(): void {
	windowStart = 0;
	windowCount = 0;
}
