/**
 * 8gent AI - Task-scoped harness overlay (#4502)
 *
 * Concept from Harness2 (arXiv 2610.14224): rewrite the harness around one
 * task, model fixed. Here the rewrite is guidance only. An overlay may add
 * prompt notes and tool hints and tighten two numeric knobs inside the
 * profile's bounds. It never loosens a limit and never carries permissions,
 * allowlists or policy (the schema rejects those keys anywhere in the object).
 * It lives in ~/.8gent/harness/overlays/<task_id>.json and is deleted when the
 * task ends. Promotion to a profile is a proposal file, never automatic.
 * Behind EIGHT_HARNESS_OVERLAY=1, default off.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HARNESS_BOUNDS, type HarnessProfile } from "./harness-profile";

export interface HarnessOverlay {
	task_id: string;
	/** The session that created it; an overlay is ignored and deleted by any other session. */
	session_id: string;
	created: string;
	expires_with: "task";
	guidance: {
		prompt_notes: string[];
		tool_hints: Record<string, string>;
		step_budget?: number;
		nudge?: number;
	};
}

export const FORBIDDEN_KEYS = ["permission", "allow", "deny", "policy", "system_one", "sandbox"];
const MAX_NOTES = 8;
const MAX_TEXT = 400;
const MAX_HINTS = 8;
const MAX_HINT_KEY = 64;
/** An overlay older than this is stale whatever else is true (crash, no end hook). */
export const MAX_OVERLAY_AGE_MS = 6 * 60 * 60 * 1000;
/** The tool-shell mark (packages/permissions/nested-guard.ts, #4715). A model can reach `8gent overlay write` only through a tool shell. */
const TOOL_SHELL_MARK = "EIGHT_PARENT_SESSION";
const ID_RE = /^[A-Za-z0-9._-]{1,80}$/;

export function overlayEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return env.EIGHT_HARNESS_OVERLAY === "1";
}

export function overlayDir(): string {
	return join(process.env.EIGHT_HARNESS_DIR || join(homedir(), ".8gent", "harness"), "overlays");
}

function forbiddenKey(value: unknown): string | null {
	if (!value || typeof value !== "object") return null;
	for (const [k, v] of Object.entries(value)) {
		const lower = k.toLowerCase();
		if (FORBIDDEN_KEYS.some((f) => lower.includes(f))) return k;
		const inner = forbiddenKey(v);
		if (inner) return inner;
	}
	return null;
}

/** Throws on anything but a plain, bounded, guidance-only overlay. */
export function validateOverlay(raw: unknown): HarnessOverlay {
	if (!raw || typeof raw !== "object") throw new Error("overlay must be an object");
	const bad = forbiddenKey(raw);
	if (bad) throw new Error(`overlay key "${bad}" is not allowed`);
	const o = raw as Record<string, any>;
	const extra = Object.keys(o).filter(
		(k) => !["task_id", "session_id", "created", "expires_with", "guidance"].includes(k),
	);
	if (extra.length) throw new Error(`unknown overlay key "${extra[0]}"`);
	if (typeof o.task_id !== "string" || !ID_RE.test(o.task_id)) throw new Error("bad task_id");
	if (typeof o.session_id !== "string" || !ID_RE.test(o.session_id))
		throw new Error("bad session_id");
	if (typeof o.created !== "string" || Number.isNaN(Date.parse(o.created))) {
		throw new Error("created must be an ISO date string");
	}
	if (o.expires_with !== "task") throw new Error('expires_with must be "task"');
	const g = o.guidance;
	if (!g || typeof g !== "object") throw new Error("guidance missing");
	const gx = Object.keys(g).filter(
		(k) => !["prompt_notes", "tool_hints", "step_budget", "nudge"].includes(k),
	);
	if (gx.length) throw new Error(`unknown guidance key "${gx[0]}"`);
	const text = (s: unknown) => typeof s === "string" && s.length > 0 && s.length <= MAX_TEXT;
	if (
		!Array.isArray(g.prompt_notes) ||
		g.prompt_notes.length > MAX_NOTES ||
		!g.prompt_notes.every(text)
	) {
		throw new Error(`prompt_notes must be up to ${MAX_NOTES} strings of up to ${MAX_TEXT} chars`);
	}
	const hints = g.tool_hints ?? {};
	if (typeof hints !== "object" || Array.isArray(hints) || !Object.values(hints).every(text)) {
		throw new Error("tool_hints must map tool name to a short string");
	}
	if (Object.keys(hints).length > MAX_HINTS) {
		throw new Error(`tool_hints must have at most ${MAX_HINTS} entries`);
	}
	if (Object.keys(hints).some((k) => k.length === 0 || k.length > MAX_HINT_KEY)) {
		throw new Error(`tool_hints keys must be 1 to ${MAX_HINT_KEY} chars`);
	}
	for (const k of ["step_budget", "nudge"] as const) {
		if (g[k] !== undefined && (typeof g[k] !== "number" || !Number.isFinite(g[k]))) {
			throw new Error(`${k} must be a number`);
		}
	}
	return { ...o, guidance: { ...g, tool_hints: hints } } as HarnessOverlay;
}

export function overlayPath(taskId: string): string {
	if (!ID_RE.test(taskId)) throw new Error("bad task_id");
	return join(overlayDir(), `${taskId}.json`);
}

/** Refuses inside a tool shell: model output must not plant guidance for later turns. */
export function writeOverlay(
	raw: unknown,
	env: Record<string, string | undefined> = process.env,
): string {
	if (env[TOOL_SHELL_MARK] !== undefined) {
		throw new Error("refusing to write an overlay from inside an 8gent tool shell");
	}
	const o = validateOverlay(raw);
	mkdirSync(overlayDir(), { recursive: true });
	const path = overlayPath(o.task_id);
	writeFileSync(path, `${JSON.stringify(o, null, 2)}\n`);
	return path;
}

/** The overlay for a task, or null (missing, malformed or rejected: never throws). */
export function loadOverlay(taskId: string | undefined): HarnessOverlay | null {
	if (!taskId || !ID_RE.test(taskId)) return null;
	try {
		return validateOverlay(JSON.parse(readFileSync(overlayPath(taskId), "utf8")));
	} catch {
		return null;
	}
}

/**
 * The ONE expiry gate. The overlay for the current EIGHT_TASK_ID, or null. A file is
 * deleted and ignored when its task id differs from the current one, when it was created
 * by another session, or when it is older than MAX_OVERLAY_AGE_MS.
 */
export function loadLiveOverlay(
	env: Record<string, string | undefined>,
	sessionId: string | undefined,
	now: number = Date.now(),
): HarnessOverlay | null {
	const taskId = env.EIGHT_TASK_ID;
	const overlay = loadOverlay(taskId);
	if (!overlay || !taskId) return null;
	const age = now - Date.parse(overlay.created);
	const live =
		overlay.task_id === taskId &&
		sessionId !== undefined &&
		overlay.session_id === sessionId &&
		age <= MAX_OVERLAY_AGE_MS;
	if (live) return overlay;
	try {
		dropOverlay(taskId);
	} catch {}
	return null;
}

export function listOverlays(): string[] {
	if (!existsSync(overlayDir())) return [];
	return readdirSync(overlayDir())
		.filter((f) => f.endsWith(".json"))
		.map((f) => f.slice(0, -5));
}

/** Expiry: called when the task ends. Returns true when a file was deleted. */
export function dropOverlay(taskId: string): boolean {
	const path = overlayPath(taskId);
	if (!existsSync(path)) return false;
	rmSync(path);
	return true;
}

/** Profile first, then overlay. The overlay can only lower maxSteps and nudgeFraction, never below the bounds. */
export function mergeOverlay(
	profile: HarnessProfile,
	overlay: HarnessOverlay | null,
): HarnessProfile {
	if (!overlay) return profile;
	const { step_budget, nudge } = overlay.guidance;
	const out = { ...profile };
	if (step_budget !== undefined) {
		out.maxSteps = Math.round(
			Math.max(HARNESS_BOUNDS.maxSteps[0], Math.min(profile.maxSteps, step_budget)),
		);
	}
	if (nudge !== undefined) {
		out.nudgeFraction = Math.max(
			HARNESS_BOUNDS.nudgeFraction[0],
			Math.min(profile.nudgeFraction, nudge),
		);
	}
	return out;
}

/** Overlay applied after the profile when the flag is on and the task has one. */
export function applyOverlay(
	profile: HarnessProfile,
	env: Record<string, string | undefined> = process.env,
	sessionId?: string,
): { profile: HarnessProfile; overlay: HarnessOverlay | null; line: string | null } {
	if (!overlayEnabled(env)) return { profile, overlay: null, line: null };
	const overlay = loadLiveOverlay(env, sessionId);
	if (!overlay) return { profile, overlay: null, line: null };
	const n = overlay.guidance.prompt_notes.length;
	const m = Object.keys(overlay.guidance.tool_hints).length;
	return {
		profile: mergeOverlay(profile, overlay),
		overlay,
		line: `[harness] overlay ${overlay.task_id} applied: ${n} notes, ${m} hints`,
	};
}

/** The text a run appends to its context: the notes, then one line per tool hint. */
export function overlayGuidanceText(overlay: HarnessOverlay | null): string {
	if (!overlay) return "";
	const { prompt_notes, tool_hints } = overlay.guidance;
	return [...prompt_notes, ...Object.entries(tool_hints).map(([t, h]) => `${t}: ${h}`)].join("\n");
}

/** Promotion is a proposal for the scorecard gate to judge, never a profile edit. */
export function proposePromotion(taskId: string, why: string): string {
	const overlay = loadOverlay(taskId);
	if (!overlay) throw new Error(`no valid overlay for ${taskId}`);
	const dir = join(overlayDir(), "..", "proposals");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${taskId}.json`);
	writeFileSync(path, `${JSON.stringify({ overlay, why, status: "proposed" }, null, 2)}\n`);
	return path;
}

/** Guidance text for the current task (EIGHT_TASK_ID), "" when the flag is off or no overlay exists. */
export function overlayNotes(
	env: Record<string, string | undefined> = process.env,
	sessionId?: string,
): string {
	return overlayEnabled(env) ? overlayGuidanceText(loadLiveOverlay(env, sessionId)) : "";
}
