/**
 * desktop_act: one grounded, gated, verified desktop action for a local model.
 *
 *   preflight -> screenshot -> ground(target) -> map to screen points
 *   -> policy (desktop_use) + approval card -> act -> verify on a fresh frame
 *
 * The model names WHAT to act on ("the Save button"); the local grounder
 * (packages/eyes/ground) says WHERE. The policy engine decides whether the
 * act may happen at all, the person decides whether it happens now, and a
 * second screenshot decides whether it did anything. Success is never
 * claimed without that second frame.
 *
 * Every effectful dependency is injected so the flow is testable without a
 * screen, a model or a person. Production wiring lives in
 * packages/eight/tools.ts (handleDesktopAct).
 */
import { spawnSync } from "node:child_process";
import type { GroundOutcome } from "../eyes/ground";
import type { CommandResult, Point, ScreenshotResult } from "./types";

export type DesktopActAction = "click" | "double_click" | "right_click" | "type" | "press";
export const DESKTOP_ACT_ACTIONS: readonly DesktopActAction[] = [
	"click",
	"double_click",
	"right_click",
	"type",
	"press",
];

export interface DesktopActArgs {
	target: string;
	action: DesktopActAction;
	text?: string;
	keys?: string;
}

/** Below this the grounder's answer is treated as "not found" (see ground/types.ts). */
export const DESKTOP_ACT_MIN_CONFIDENCE = 0.5;
/** Acts per executor session. A local model does not get an unbounded desktop. */
export const DESKTOP_ACT_MAX_STEPS = 50;
/** The same act at the same point this many times in a row stops the session's acting. */
export const DESKTOP_ACT_REPEAT_LIMIT = 3;
/** Pixels either side of the point compared before/after the act. */
export const VERIFY_RADIUS = 60;

export interface DesktopActApproval {
	action: DesktopActAction;
	target: string;
	point: Point;
	keys?: string;
	/** Length only: typed text never reaches a card or a log. */
	textLength?: number;
	confidence: number;
}

export interface DesktopActPolicyDecision {
	allowed: boolean;
	requiresApproval?: boolean;
	reason?: string;
}

export interface DesktopActDeps {
	/** One-line grant check. Skipped in dry run. */
	preflight: () => { ok: boolean; line?: string };
	screenshot: () => ScreenshotResult;
	ground: (imagePath: string, instruction: string) => Promise<GroundOutcome>;
	/** desktop_use policy for {action, keys}. */
	policy: (ctx: { action: string; keys?: string }) => DesktopActPolicyDecision;
	/** Returns the refusal to hand the model, or null when the person approved. */
	approve: (req: DesktopActApproval, reason: string) => Promise<string | null>;
	click: (point: Point, button: "left" | "right", count: number) => CommandResult;
	type: (text: string) => CommandResult;
	press: (keys: string) => CommandResult;
	/** Points per image pixel: 2 on a Retina display. */
	screenScale: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Pre/post frame comparison; default compares PNG files with sharp. */
	changed?: (before: string, after: string, point: Point) => Promise<FrameChange>;
	/** When set, the act is recorded but never executed and preflight is skipped. */
	dryRun?: boolean;
}

export type FrameChange = "near point" | "frame" | "none";

export interface DesktopActResult {
	ok: boolean;
	action: DesktopActAction;
	target: string;
	/** Set once the grounder found the target. Screen points. */
	point?: Point;
	/** Image pixels, for the person reading the screenshot. */
	imagePoint?: Point;
	confidence?: number;
	/** True only when a fresh frame differed after the act. */
	verified?: boolean;
	change?: FrameChange;
	/** Why nothing (or nothing verified) happened. */
	reason?: string;
	dryRun?: boolean;
	ms: number;
}

/** Per-executor counters for the safety stops. */
export class DesktopActSession {
	steps = 0;
	private lastKey = "";
	private repeats = 0;

	/** Records an intended act; returns a stop reason when a cap is hit. */
	admit(key: string): string | null {
		if (this.steps >= DESKTOP_ACT_MAX_STEPS) {
			return `Step cap reached (${DESKTOP_ACT_MAX_STEPS} desktop acts this session). Stop and report.`;
		}
		if (key === this.lastKey) this.repeats++;
		else {
			this.lastKey = key;
			this.repeats = 1;
		}
		if (this.repeats >= DESKTOP_ACT_REPEAT_LIMIT) {
			return `The same act at the same point was asked ${this.repeats} times in a row. Stopped; the screen is not responding to it.`;
		}
		this.steps++;
		return null;
	}
}

export function policyActionFor(action: DesktopActAction): "click" | "type" | "press" {
	return action === "type" ? "type" : action === "press" ? "press" : "click";
}

export function validateDesktopActArgs(args: Record<string, unknown>): DesktopActArgs | string {
	const target = typeof args.target === "string" ? args.target.trim() : "";
	const action = args.action as DesktopActAction;
	if (!DESKTOP_ACT_ACTIONS.includes(action)) {
		return `desktop_act: action must be one of ${DESKTOP_ACT_ACTIONS.join(", ")}`;
	}
	if (!target) return 'desktop_act: target is required (what to act on, e.g. "the Save button")';
	const text = typeof args.text === "string" ? args.text : undefined;
	const keys = typeof args.keys === "string" ? args.keys.trim() : undefined;
	if (action === "type" && !text) return "desktop_act: type needs text";
	if (action === "press" && !keys) return 'desktop_act: press needs keys (e.g. "enter", "cmd+s")';
	return { target, action, text, keys };
}

let cachedScale: number | null = null;

/**
 * Points per pixel of the main display from system_profiler ("Resolution:
 * 2880 x 1800 Retina" against "UI Looks like: 1440 x 900"). The driver's
 * screenshots are in pixels and cliclick takes points, so without this a
 * Retina click lands at twice the distance from the origin. Falls back to 1
 * when the display cannot be read (no WindowServer, sandbox).
 */
export function detectScreenScale(): number {
	if (cachedScale !== null) return cachedScale;
	let scale = 1;
	try {
		const r = spawnSync("/usr/sbin/system_profiler", ["SPDisplaysDataType"], {
			encoding: "utf-8",
			timeout: 8000,
		});
		const res = /Resolution:\s*(\d+)\s*x\s*(\d+)/.exec(r.stdout || "");
		const ui = /UI Looks like:\s*(\d+)\s*x\s*(\d+)/.exec(r.stdout || "");
		if (res && ui && Number(ui[1]) > 0) scale = Number(res[1]) / Number(ui[1]);
	} catch {
		/* fall back to 1 */
	}
	cachedScale = scale > 0 && Number.isFinite(scale) ? scale : 1;
	return cachedScale;
}

/** Test-only. */
export function _resetScreenScale(): void {
	cachedScale = null;
}

/** sharp is loaded lazily (#3892): a static import crashes the standalone Windows exe. */
async function loadSharp() {
	return (await import("sharp")).default;
}

async function regionRaw(path: string, left: number, top: number, size: number) {
	const sharp = await loadSharp();
	const img = sharp(path);
	const meta = await img.metadata();
	const w = meta.width ?? 0;
	const h = meta.height ?? 0;
	const l = Math.max(0, Math.min(left, w - 1));
	const t = Math.max(0, Math.min(top, h - 1));
	const width = Math.max(1, Math.min(size, w - l));
	const height = Math.max(1, Math.min(size, h - t));
	return img.extract({ left: l, top: t, width, height }).raw().toBuffer();
}

function fractionDiffering(a: Buffer, b: Buffer): number {
	if (a.length !== b.length || a.length === 0) return 1;
	let diff = 0;
	for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 16) diff++;
	return diff / a.length;
}

/**
 * Did the screen change after the act? Looks near the point first (a
 * pressed button, a focused field), then at a downscaled whole frame (a
 * dialog elsewhere). Two identical files answer "none".
 */
export async function frameChange(
	before: string,
	after: string,
	imagePoint: Point,
): Promise<FrameChange> {
	const size = VERIFY_RADIUS * 2;
	const [a, b] = await Promise.all([
		regionRaw(before, imagePoint.x - VERIFY_RADIUS, imagePoint.y - VERIFY_RADIUS, size),
		regionRaw(after, imagePoint.x - VERIFY_RADIUS, imagePoint.y - VERIFY_RADIUS, size),
	]);
	if (fractionDiffering(a, b) > 0.01) return "near point";
	const sharp = await loadSharp();
	const [fa, fb] = await Promise.all(
		[before, after].map((p) => sharp(p).resize(128, 128, { fit: "fill" }).raw().toBuffer()),
	);
	if (fractionDiffering(fa, fb) > 0.005) return "frame";
	return "none";
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function desktopAct(
	args: DesktopActArgs,
	deps: DesktopActDeps,
	session: DesktopActSession,
): Promise<DesktopActResult> {
	const t0 = performance.now();
	const done = (r: Omit<DesktopActResult, "ms" | "action" | "target">): DesktopActResult => ({
		action: args.action,
		target: args.target,
		...r,
		ms: Math.round(performance.now() - t0),
		...(deps.dryRun ? { dryRun: true } : {}),
	});

	// 1. A block is a block before any screen or model is touched.
	const policyCtx = { action: policyActionFor(args.action), keys: args.keys };
	const decision = deps.policy(policyCtx);
	if (!decision.allowed && !decision.requiresApproval) {
		return done({
			ok: false,
			reason: `Blocked by policy: ${(decision.reason ?? "desktop_use rule").replace(/\.$/, "")}. Nothing was done.`,
		});
	}

	// 2. Missing macOS grants: one line, no workaround.
	if (!deps.dryRun) {
		const pre = deps.preflight();
		if (!pre.ok)
			return done({ ok: false, reason: pre.line ?? "Desktop permissions are not granted." });
	}

	// 3. See, then find.
	const shot = deps.screenshot();
	if (!shot.ok) return done({ ok: false, reason: `Screenshot failed: ${shot.error ?? "unknown"}` });
	const found = await deps.ground(shot.path, args.target);
	if (!found.ok) return done({ ok: false, reason: `Target not found: ${found.reason}` });
	const imagePoint = { x: found.x, y: found.y };
	if (found.confidence < DESKTOP_ACT_MIN_CONFIDENCE) {
		return done({
			ok: false,
			imagePoint,
			confidence: found.confidence,
			reason: `Target not found with enough confidence (${found.confidence}). Nothing was done.`,
		});
	}

	// 4. Image pixels -> screen points. The capture is the full display, so the
	//    only correction is the display's pixel density.
	const scale = deps.screenScale();
	const point = {
		x: Math.round(shot.coordMap.captureX + imagePoint.x / scale),
		y: Math.round(shot.coordMap.captureY + imagePoint.y / scale),
	};

	// 5. Safety stops, then the person.
	const key = `${args.action}@${point.x},${point.y}:${args.keys ?? ""}:${args.text?.length ?? 0}`;
	const stop = session.admit(key);
	if (stop)
		return done({ ok: false, point, imagePoint, confidence: found.confidence, reason: stop });
	if (!decision.allowed && decision.requiresApproval) {
		const refusal = await deps.approve(
			{
				action: args.action,
				target: args.target,
				point,
				keys: args.keys,
				textLength: args.text?.length,
				confidence: found.confidence,
			},
			decision.reason ?? "This desktop action needs your approval.",
		);
		if (refusal)
			return done({ ok: false, point, imagePoint, confidence: found.confidence, reason: refusal });
	}

	// 6. Act.
	let acted: CommandResult = { ok: true };
	if (!deps.dryRun) {
		switch (args.action) {
			case "click":
				acted = deps.click(point, "left", 1);
				break;
			case "double_click":
				acted = deps.click(point, "left", 2);
				break;
			case "right_click":
				acted = deps.click(point, "right", 1);
				break;
			case "type":
				acted = deps.click(point, "left", 1);
				if (acted.ok) acted = deps.type(args.text ?? "");
				break;
			case "press":
				// Focus the target first so the keys land where the model aimed.
				acted = deps.click(point, "left", 1);
				if (acted.ok) acted = deps.press(args.keys ?? "");
				break;
		}
	}
	if (!acted.ok) {
		return done({
			ok: false,
			point,
			imagePoint,
			confidence: found.confidence,
			reason: `Act failed: ${acted.error}`,
		});
	}

	// 7. Verify on a fresh frame. No frame, no claim.
	await (deps.sleep ?? wait)(deps.dryRun ? 0 : 300);
	const after = deps.screenshot();
	if (!after.ok) {
		return done({
			ok: true,
			point,
			imagePoint,
			confidence: found.confidence,
			verified: false,
			reason: `Acted, but could not verify: second screenshot failed (${after.error ?? "unknown"}).`,
		});
	}
	const change = await (deps.changed ?? frameChange)(shot.path, after.path, imagePoint);
	return done({
		ok: true,
		point,
		imagePoint,
		confidence: found.confidence,
		verified: change !== "none",
		change,
		...(change === "none" ? { reason: "Acted, but the screen did not change. Not verified." } : {}),
	});
}

/** OpenAI-style definition, one-line description for a compact local prompt. */
export const DESKTOP_ACT_TOOL_DEF = {
	type: "function",
	function: {
		name: "desktop_act",
		description:
			"[DESKTOP] Find `target` on screen with the local grounder and click, type or press there; asks the person first and verifies on a fresh screenshot.",
		parameters: {
			type: "object",
			properties: {
				target: { type: "string", description: 'What to act on, e.g. "the Save button"' },
				action: { type: "string", enum: [...DESKTOP_ACT_ACTIONS] },
				text: { type: "string", description: "Text to type (action=type)" },
				keys: { type: "string", description: 'Key combo (action=press), e.g. "enter", "cmd+s"' },
			},
			required: ["target", "action"],
		},
	},
} as const;
