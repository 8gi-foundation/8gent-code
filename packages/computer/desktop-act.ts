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
import { isDangerousCombo, normalizeKeys } from "./keys";
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
/**
 * After the person approves, the target is grounded again on a fresh frame.
 * If it moved more than this many screen points, the approved point is stale
 * and the person is asked again with the new one.
 */
export const REGROUND_TOLERANCE_PT = 8;
/** Cards shown for one act before it is abandoned because the target keeps moving. */
export const DESKTOP_ACT_MAX_ASKS = 2;

export interface DesktopActApproval {
	action: DesktopActAction;
	target: string;
	point: Point;
	keys?: string;
	/** Length, for anything that is logged. */
	textLength?: number;
	/**
	 * The exact text a `type` act will enter. For the approval card ONLY: the
	 * person must see what will be typed, but it never goes to a log, the audit
	 * trail or the tool result.
	 */
	text?: string;
	/** The screen around the point as terminal art, for the card only. */
	crop?: string;
	confidence: number;
	/** 1 for the first card, 2 when the target moved after approval. */
	attempt: number;
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
	/** Terminal art of the frame around the point for the card; default renderCrop. */
	crop?: (imagePath: string, imagePoint: Point) => Promise<string>;
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

/** Image pixels either side of the point shown on the card (half that above and below). */
export const CROP_RADIUS = 240;
/** Card art width in terminal columns; each row is two pixel rows (half blocks). */
export const CROP_COLS = 64;

/**
 * The screen around the point as truecolor half-block art, with the point
 * marked in red, so the person sees what will be acted on without leaving
 * the card. Rendered in memory; no image of the screen is written anywhere.
 */
export async function renderCrop(imagePath: string, p: Point): Promise<string> {
	const sharp = await loadSharp();
	const meta = await sharp(imagePath).metadata();
	const w = meta.width ?? 0;
	const h = meta.height ?? 0;
	if (!w || !h) return "";
	const left = Math.max(0, Math.min(Math.round(p.x - CROP_RADIUS), w - 1));
	const top = Math.max(0, Math.min(Math.round(p.y - CROP_RADIUS / 2), h - 1));
	const cw = Math.max(1, Math.min(CROP_RADIUS * 2, w - left));
	const ch = Math.max(1, Math.min(CROP_RADIUS, h - top));
	const cols = CROP_COLS;
	const rows = Math.max(2, Math.round((cols * ch) / cw / 2) * 2);
	const { data, info } = await sharp(imagePath)
		.extract({ left, top, width: cw, height: ch })
		.resize(cols, rows, { fit: "fill" })
		.removeAlpha()
		.raw()
		.toBuffer({ resolveWithObject: true });
	const mx = Math.round(((p.x - left) / cw) * (cols - 1));
	const my = Math.round(((p.y - top) / ch) * (rows - 1));
	const px = (x: number, y: number): [number, number, number] => {
		if ((x === mx && Math.abs(y - my) <= 1) || (y === my && Math.abs(x - mx) <= 2))
			return [255, 0, 0];
		const i = (y * info.width + x) * 3;
		return [data[i], data[i + 1], data[i + 2]];
	};
	const lines: string[] = [];
	for (let y = 0; y < rows; y += 2) {
		let line = "";
		for (let x = 0; x < cols; x++) {
			const [r1, g1, b1] = px(x, y);
			const [r2, g2, b2] = px(x, Math.min(y + 1, rows - 1));
			line += `\x1b[38;2;${r1};${g1};${b1}m\x1b[48;2;${r2};${g2};${b2}m▀`;
		}
		lines.push(`${line}\x1b[0m`);
	}
	return lines.join("\n");
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

	// 1. A block is a block before any screen or model is touched. Keys are
	//    matched in their canonical spelling, here and in the policy rules.
	const keys = args.keys === undefined ? undefined : normalizeKeys(args.keys);
	const dangerous = keys ? isDangerousCombo(keys) : null;
	if (dangerous) {
		return done({
			ok: false,
			reason: `Blocked: "${keys}" would fire ${dangerous} (quit, close, log out or force quit). Nothing was done.`,
		});
	}
	const policyCtx = { action: policyActionFor(args.action), keys };
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
	let shot = deps.screenshot();
	if (!shot.ok) return done({ ok: false, reason: `Screenshot failed: ${shot.error ?? "unknown"}` });
	const first = await deps.ground(shot.path, args.target);
	if (!first.ok) return done({ ok: false, reason: `Target not found: ${first.reason}` });
	let found: Extract<GroundOutcome, { ok: true }> = first;
	if (found.confidence < DESKTOP_ACT_MIN_CONFIDENCE) {
		return done({
			ok: false,
			imagePoint: { x: found.x, y: found.y },
			confidence: found.confidence,
			reason: `Target not found with enough confidence (${found.confidence}). Nothing was done.`,
		});
	}

	// 4. Image pixels -> screen points. The capture is the full display, so the
	//    only correction is the display's pixel density.
	const scale = deps.screenScale();
	const toScreen = (s: ScreenshotResult, p: Point): Point => ({
		x: Math.round(s.coordMap.captureX + p.x / scale),
		y: Math.round(s.coordMap.captureY + p.y / scale),
	});
	let imagePoint = { x: found.x, y: found.y };
	let point = toScreen(shot, imagePoint);

	// 5. Safety stops, then the person. Every act asks, whatever the policy
	//    allows and whatever was approved before: there is no session grant.
	const key = `${args.action}@${point.x},${point.y}:${keys ?? ""}:${args.text?.length ?? 0}`;
	const stop = session.admit(key);
	if (stop)
		return done({ ok: false, point, imagePoint, confidence: found.confidence, reason: stop });
	const reason = decision.reason ?? "This desktop action needs your approval.";
	for (let attempt = 1; ; attempt++) {
		const crop = await (deps.crop ?? renderCrop)(shot.path, imagePoint).catch(() => "");
		const refusal = await deps.approve(
			{
				action: args.action,
				target: args.target,
				point,
				keys,
				textLength: args.text?.length,
				...(args.action === "type" ? { text: args.text } : {}),
				...(crop ? { crop } : {}),
				confidence: found.confidence,
				attempt,
			},
			attempt === 1 ? reason : `The target moved after you approved. ${reason}`,
		);
		if (refusal)
			return done({ ok: false, point, imagePoint, confidence: found.confidence, reason: refusal });

		// 5b. The screen may have changed while the card was up. Ground again on
		//     a fresh frame; act only if the target is still where it was approved.
		const fresh = deps.screenshot();
		if (!fresh.ok) {
			return done({
				ok: false,
				point,
				imagePoint,
				reason: `Screenshot after approval failed: ${fresh.error ?? "unknown"}. Nothing was done.`,
			});
		}
		const again = await deps.ground(fresh.path, args.target);
		const lost = !again.ok || again.confidence < DESKTOP_ACT_MIN_CONFIDENCE;
		const nextImage = again.ok ? { x: again.x, y: again.y } : imagePoint;
		const nextPoint = toScreen(fresh, nextImage);
		const moved = Math.hypot(nextPoint.x - point.x, nextPoint.y - point.y);
		if (!lost && moved <= REGROUND_TOLERANCE_PT) {
			shot = fresh; // the verify baseline is the frame the act lands on
			break;
		}
		const why = lost
			? "the target could not be found again with enough confidence after approval"
			: `the target moved ${Math.round(moved)} points after approval`;
		if (lost || attempt >= DESKTOP_ACT_MAX_ASKS) {
			return done({
				ok: false,
				point,
				imagePoint,
				confidence: found.confidence,
				reason: `Aborted: ${why}. Nothing was done.`,
			});
		}
		// Ask again, with the new point and the new crop.
		shot = fresh;
		found = again;
		imagePoint = nextImage;
		point = nextPoint;
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
				if (acted.ok) acted = deps.press(keys ?? "");
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
			"[DESKTOP] Finds target on screen and does action there (click, type text, press keys); asks the person first, then verifies.",
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
