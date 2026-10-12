/**
 * desktop_act: grounded, gated, verified. Every effectful dependency is a
 * stub here; the real policy engine and the real TUI approval channel are
 * exercised so the gate is tested, not simulated.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import sharp from "sharp";
import type { GroundOutcome } from "../eyes/ground";
import { evaluatePolicy } from "../permissions/policy-engine";
import {
	_resetTuiApprovalChannel,
	hasTuiApprovalHandler,
	registerTuiApprovalHandler,
	requestTuiApproval,
} from "../permissions/tui-approval-channel";
import {
	DESKTOP_ACT_MAX_STEPS,
	DESKTOP_ACT_TOOL_DEF,
	type DesktopActApproval,
	type DesktopActDeps,
	DesktopActSession,
	REGROUND_TOLERANCE_PT,
	desktopAct,
	frameChange,
	renderCrop,
	validateDesktopActArgs,
} from "./desktop-act";
import {
	askOnTerminal,
	desktopApprovalCard,
	desktopApprovalDetails,
	loggableToolArgs,
} from "./desktop-approval";
import { desktopPolicyContext } from "./desktop-policy";
import { isDangerousCombo, normalizeKeys } from "./keys";
import {
	_resetPreflightCache,
	desktopPreflight,
	preflightFromReport,
	resolveHostApp,
} from "./preflight";

const dir = mkdtempSync(join(tmpdir(), "desktop-act-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function png(name: string, paint?: (svg: string) => string): Promise<string> {
	const base = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#fff"/><rect x="150" y="120" width="100" height="40" fill="#1f6feb"/></svg>`;
	const svg = paint ? paint(base) : base;
	const out = join(dir, name);
	writeFileSync(out, await sharp(Buffer.from(svg)).png().toBuffer());
	return out;
}

/** The production approval rule in miniature: a card if there is one, else refuse. */
async function approveLikeTheExecutor(
	req: DesktopActApproval,
	reason: string,
): Promise<string | null> {
	if (!hasTuiApprovalHandler()) {
		return `[BLOCKED] desktop_act needs the person's approval and there is no one to ask in this session. Nothing was done.`;
	}
	const ok = await requestTuiApproval({
		action: "Desktop control",
		details: desktopApprovalDetails(req, reason),
		command: desktopApprovalCard(req, reason),
		full: true,
	});
	return ok ? null : "[PERMISSION DENIED] The person declined desktop_act. Nothing was done.";
}

function found(x = 200, y = 140, confidence = 1): GroundOutcome {
	return {
		ok: true,
		x,
		y,
		bbox: [150, 120, 250, 160],
		confidence,
		backend: "stub",
		model: "stub",
		ms: 1,
	};
}

interface Calls {
	clicks: Array<{ x: number; y: number; button: string; count: number }>;
	typed: string[];
	pressed: string[];
	shots: number;
}

function deps(
	over: Partial<DesktopActDeps> & { before: string; after?: string },
	calls: Calls,
): DesktopActDeps {
	// First look, the look after approval (re-ground), then the frame after the act.
	const frames = [over.before, over.before, over.after ?? over.before];
	return {
		preflight: () => ({ ok: true }),
		screenshot: () => {
			const path = frames[Math.min(calls.shots, frames.length - 1)];
			calls.shots++;
			return {
				ok: true,
				path,
				coordMap: {
					captureX: 0,
					captureY: 0,
					captureWidth: 400,
					captureHeight: 300,
					imageWidth: 400,
					imageHeight: 300,
				},
			};
		},
		ground: async () => found(),
		policy: (ctx) => evaluatePolicy("desktop_use", ctx),
		approve: approveLikeTheExecutor,
		click: (p, button, count) => {
			calls.clicks.push({ ...p, button, count });
			return { ok: true };
		},
		type: (t) => {
			calls.typed.push(t);
			return { ok: true };
		},
		press: (k) => {
			calls.pressed.push(k);
			return { ok: true };
		},
		screenScale: () => 1,
		sleep: async () => {},
		...over,
	};
}

const fresh = (): Calls => ({ clicks: [], typed: [], pressed: [], shots: 0 });

describe("desktop_act gate", () => {
	let before: string;
	let after: string;
	const prevHeadless = process.env.EIGHT_HEADLESS;
	beforeEach(async () => {
		before = await png("before.png");
		after = await png("after.png", (s) => s.replace("#1f6feb", "#d73a49"));
	});
	afterEach(() => {
		_resetTuiApprovalChannel();
		if (prevHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		else process.env.EIGHT_HEADLESS = prevHeadless;
	});

	test("headless: a click is denied and nothing moves", async () => {
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toStartWith("[BLOCKED]");
		expect(r.point).toEqual({ x: 200, y: 140 });
		expect(calls.clicks.length).toBe(0);
		expect(calls.shots).toBe(1);
	});

	test("TUI approve: the click runs, shows target and point on the card, and is verified on the changed frame", async () => {
		const cards: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			cards.push(req.command ?? "");
			return "approve";
		});
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, after }, calls),
			new DesktopActSession(),
		);
		expect(cards.length).toBe(1);
		expect(cards[0]).toContain("click the blue button");
		expect(cards[0]).toContain("at screen point (200, 140)");
		expect(calls.clicks).toEqual([{ x: 200, y: 140, button: "left", count: 1 }]);
		expect(r.ok).toBe(true);
		expect(r.verified).toBe(true);
		expect(r.change).toBe("near point");
		expect(calls.shots).toBe(3);
	});

	test("TUI deny: nothing runs", async () => {
		registerTuiApprovalHandler(async () => "deny");
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "type", text: "hello" },
			deps({ before }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("[PERMISSION DENIED]");
		expect(calls.clicks.length).toBe(0);
		expect(calls.typed.length).toBe(0);
	});

	test("cmd+q is blocked by the YAML before any screenshot, model or card", async () => {
		let asked = 0;
		registerTuiApprovalHandler(async () => {
			asked++;
			return "approve";
		});
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the window", action: "press", keys: "cmd+q" },
			deps({ before }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("Blocked");
		expect(asked).toBe(0);
		expect(calls.shots).toBe(0);
		expect(calls.pressed.length).toBe(0);
	});

	test("screenshot and the act_resolve pre-gate stay allowed; click, type, press ask", () => {
		expect(evaluatePolicy("desktop_use", { action: "screenshot" }).allowed).toBe(true);
		expect(evaluatePolicy("desktop_use", desktopPolicyContext("desktop_act", {})).allowed).toBe(
			true,
		);
		for (const action of ["click", "type", "press"]) {
			const d = evaluatePolicy("desktop_use", { action });
			expect(d.allowed).toBe(false);
			expect(d.allowed === false && d.requiresApproval).toBe(true);
		}
	});

	test("approved but the screen did not change: ok, verified false, says so", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(true);
		expect(r.verified).toBe(false);
		expect(r.change).toBe("none");
		expect(r.reason).toContain("Not verified");
	});

	test("low confidence: not found, no card, no act", async () => {
		let asked = 0;
		registerTuiApprovalHandler(async () => {
			asked++;
			return "approve";
		});
		const calls = fresh();
		const r = await desktopAct(
			{ target: "a unicorn", action: "click" },
			deps({ before, ground: async () => found(10, 10, 0.3) }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("not found");
		expect(asked).toBe(0);
		expect(calls.clicks.length).toBe(0);
	});

	test("Retina: image pixels map to screen points", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "right_click" },
			deps({ before, after, screenScale: () => 2 }, calls),
			new DesktopActSession(),
		);
		expect(r.imagePoint).toEqual({ x: 200, y: 140 });
		expect(r.point).toEqual({ x: 100, y: 70 });
		expect(calls.clicks[0]).toEqual({ x: 100, y: 70, button: "right", count: 1 });
	});

	test("the same act at the same point three times stops the session", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const session = new DesktopActSession();
		const calls = fresh();
		const args = { target: "the blue button", action: "click" as const };
		const r1 = await desktopAct(args, deps({ before }, calls), session);
		const r2 = await desktopAct(args, deps({ before }, calls), session);
		const r3 = await desktopAct(args, deps({ before }, calls), session);
		expect(r1.ok && r2.ok).toBe(true);
		expect(r3.ok).toBe(false);
		expect(r3.reason).toContain("times in a row");
		expect(calls.clicks.length).toBe(2);
	});

	test("the step cap stops acting", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const session = new DesktopActSession();
		session.steps = DESKTOP_ACT_MAX_STEPS;
		const calls = fresh();
		const r = await desktopAct({ target: "x", action: "click" }, deps({ before }, calls), session);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("Step cap");
		expect(calls.clicks.length).toBe(0);
	});

	test("dry run: full flow, act recorded only, never verified", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, dryRun: true }, calls),
			new DesktopActSession(),
		);
		expect(r.dryRun).toBe(true);
		expect(r.ok).toBe(true);
		expect(r.verified).toBe(false);
		expect(calls.clicks.length).toBe(0);
	});

	test("missing macOS grants: one line, no screenshot", async () => {
		const calls = fresh();
		const r = await desktopAct(
			{ target: "x", action: "click" },
			deps(
				{
					before,
					preflight: () => ({
						ok: false,
						line: "Grant Screen Recording to Ghostty in System Settings > Privacy & Security, then restart 8gent.",
					}),
				},
				calls,
			),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toBe(
			"Grant Screen Recording to Ghostty in System Settings > Privacy & Security, then restart 8gent.",
		);
		expect(calls.shots).toBe(0);
	});
});

describe("frameChange", () => {
	test("identical files: none; a moved pixel far away: frame; a change at the point: near point", async () => {
		const a = await png("f-a.png");
		const far = await png("f-far.png", (s) =>
			s.replace(
				'fill="#fff"/>',
				'fill="#fff"/><rect x="0" y="0" width="40" height="40" fill="#000"/>',
			),
		);
		const near = await png("f-near.png", (s) => s.replace("#1f6feb", "#000"));
		expect(await frameChange(a, a, { x: 200, y: 140 })).toBe("none");
		expect(await frameChange(a, far, { x: 200, y: 140 })).toBe("frame");
		expect(await frameChange(a, near, { x: 200, y: 140 })).toBe("near point");
	});
});

describe("args and tool definition", () => {
	test("validation", () => {
		expect(typeof validateDesktopActArgs({ action: "click" })).toBe("string");
		expect(typeof validateDesktopActArgs({ target: "x", action: "hover" })).toBe("string");
		expect(typeof validateDesktopActArgs({ target: "x", action: "type" })).toBe("string");
		expect(typeof validateDesktopActArgs({ target: "x", action: "press" })).toBe("string");
		expect(validateDesktopActArgs({ target: " x ", action: "press", keys: "enter" })).toEqual({
			target: "x",
			action: "press",
			text: undefined,
			keys: "enter",
		});
	});
	test("the description is one short line", () => {
		const d = DESKTOP_ACT_TOOL_DEF.function.description;
		expect(d).not.toContain("\n");
		expect(d.length).toBeLessThan(160);
	});
});

describe("preflight", () => {
	afterEach(() => _resetPreflightCache());
	const report = (sr: boolean, ax: boolean) => ({
		screenRecording: { granted: sr, detail: "" },
		accessibility: { granted: ax, detail: "" },
		terminalApp: "x",
		allGranted: sr && ax,
	});

	test("the grant line names exactly what is missing and the host app", () => {
		expect(preflightFromReport(report(false, false), "Ghostty").line).toBe(
			"Grant Screen Recording and Accessibility to Ghostty in System Settings > Privacy & Security, then restart 8gent.",
		);
		expect(preflightFromReport(report(true, false), "Terminal").line).toBe(
			"Grant Accessibility to Terminal in System Settings > Privacy & Security, then restart 8gent.",
		);
		expect(preflightFromReport(report(true, true), "iTerm")).toEqual({
			ok: true,
			missing: [],
			app: "iTerm",
		});
	});

	test("host app: bundle on the process tree wins, then TERM_PROGRAM", () => {
		expect(resolveHostApp({ TERM_PROGRAM: "tmux" }, () => "Ghostty")).toBe("Ghostty");
		expect(resolveHostApp({ TERM_PROGRAM: "ghostty" }, () => null)).toBe("Ghostty");
		expect(resolveHostApp({ TERM_PROGRAM: "Apple_Terminal" }, () => null)).toBe("Terminal");
		expect(resolveHostApp({ TERM_PROGRAM: "8gent" }, () => null)).toBe("8gent.app");
		expect(resolveHostApp({}, () => null)).toBe("the app running 8gent");
		// herdr/tmux rewrite TERM_PROGRAM; the Launch Services bundle id still names the app.
		expect(
			resolveHostApp(
				{ TERM_PROGRAM: "herdr", __CFBundleIdentifier: "com.apple.Terminal" },
				() => null,
			),
		).toBe("Terminal");
	});

	test("a pass is cached, a failure is re-probed", () => {
		let probes = 0;
		const failing = () => {
			probes++;
			return report(false, true);
		};
		expect(desktopPreflight(failing).ok).toBe(false);
		expect(desktopPreflight(failing).ok).toBe(false);
		expect(probes).toBe(2);
		expect(desktopPreflight(() => report(true, true)).ok).toBe(true);
		expect(desktopPreflight(failing).ok).toBe(true);
		expect(probes).toBe(2);
	});
});

describe("8SO review of #4057", () => {
	let before: string;
	let after: string;
	beforeEach(async () => {
		before = await png("8so-before.png");
		after = await png("8so-after.png", (s) => s.replace("#1f6feb", "#d73a49"));
	});
	afterEach(() => _resetTuiApprovalChannel());

	test("1. type: the exact text is on the card, never in the logged details or the result", async () => {
		const seen: { command?: string; details: string }[] = [];
		registerTuiApprovalHandler(async (req) => {
			seen.push({ command: req.command, details: req.details });
			return "approve";
		});
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the search field", action: "type", text: "hunter2 secret" },
			deps({ before, after }, calls),
			new DesktopActSession(),
		);
		expect(seen.length).toBe(1);
		expect(seen[0].command).toContain('will type exactly: "hunter2 secret"');
		expect(seen[0].details).not.toContain("hunter2");
		expect(seen[0].details).toContain('"textLength":14');
		expect(JSON.stringify(r)).not.toContain("hunter2");
		expect(calls.typed).toEqual(["hunter2 secret"]);
	});

	test("2. approval is unconditional: a policy allow and an earlier yes do not skip the card", async () => {
		let asked = 0;
		registerTuiApprovalHandler(async () => {
			asked++;
			return asked === 1 ? "approve" : "deny";
		});
		const calls = fresh();
		const session = new DesktopActSession();
		const allowAll = () => ({ allowed: true });
		const r1 = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, after, policy: allowAll }, calls),
			session,
		);
		expect(r1.ok).toBe(true);
		const r2 = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, after, policy: allowAll }, fresh()),
			session,
		);
		expect(asked).toBe(2);
		expect(r2.ok).toBe(false);
		expect(r2.reason).toContain("[PERMISSION DENIED]");
	});

	test("2b. with no one to ask, a policy allow still does nothing", async () => {
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "double_click" },
			deps({ before, policy: () => ({ allowed: true }) }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toStartWith("[BLOCKED]");
		expect(calls.clicks.length).toBe(0);
	});

	test("3. target moved after approval: asked again with the new point, act lands there", async () => {
		const cards: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			cards.push(req.command ?? "");
			return "approve";
		});
		const points = [found(200, 140), found(260, 140), found(260, 141)];
		let g = 0;
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, after, ground: async () => points[Math.min(g++, points.length - 1)] }, calls),
			new DesktopActSession(),
		);
		expect(cards.length).toBe(2);
		expect(cards[1]).toContain("AGAIN, target moved");
		expect(cards[1]).toContain("(260, 140)");
		expect(calls.clicks).toEqual([{ x: 260, y: 140, button: "left", count: 1 }]);
		expect(r.ok).toBe(true);
	});

	test("3b. target keeps moving: aborted after the second card, nothing clicked", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const points = [found(200, 140), found(260, 140), found(320, 140)];
		let g = 0;
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, ground: async () => points[Math.min(g++, points.length - 1)] }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("Aborted: the target moved");
		expect(calls.clicks.length).toBe(0);
	});

	test("3c. confidence falls below the floor after approval: aborted, nothing clicked", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const points = [found(200, 140, 1), found(200, 140, 0.2)];
		let g = 0;
		const calls = fresh();
		const r = await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, ground: async () => points[Math.min(g++, points.length - 1)] }, calls),
			new DesktopActSession(),
		);
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("could not be found again");
		expect(calls.clicks.length).toBe(0);
	});

	test("3d. a move within tolerance acts at the approved point", async () => {
		registerTuiApprovalHandler(async () => "approve");
		const points = [found(200, 140), found(200 + REGROUND_TOLERANCE_PT - 2, 140)];
		let g = 0;
		const calls = fresh();
		await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before, after, ground: async () => points[Math.min(g++, points.length - 1)] }, calls),
			new DesktopActSession(),
		);
		expect(calls.clicks).toEqual([{ x: 200, y: 140, button: "left", count: 1 }]);
	});

	test("4. the card carries a crop of the screen around the point, marked", async () => {
		const art = await renderCrop(before, { x: 200, y: 140 });
		expect(art).toContain("\u2580");
		expect(art).toContain("38;2;255;0;0"); // the red point marker
		expect(art).toContain("31;111;235"); // the blue button's own pixels
		const cards: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			cards.push(req.command ?? "");
			return "deny";
		});
		await desktopAct(
			{ target: "the blue button", action: "click" },
			deps({ before }, fresh()),
			new DesktopActSession(),
		);
		expect(cards[0]).toContain("\u2580");
	});

	test("5. keys are normalised: case, aliases, order and extra modifiers cannot walk around the block", () => {
		expect(normalizeKeys("Shift+Command+Q")).toBe("cmd+shift+q");
		expect(normalizeKeys("option+cmd+Escape")).toBe("cmd+alt+esc");
		for (const k of [
			"shift+cmd+q",
			"command+q",
			"cmd+opt+esc",
			"Command+Option+Escape",
			"CMD+Q",
			"q+cmd",
			"cmd+alt+q",
			"control+option+delete",
			"ctrl+alt+backspace",
		]) {
			expect(isDangerousCombo(k)).not.toBeNull();
			const d = evaluatePolicy("desktop_use", desktopPolicyContext("desktop_press", { keys: k }));
			if (["cmd+alt+q", "ctrl+alt+backspace", "q+cmd"].includes(k)) continue; // code-level block covers these
			expect(d.allowed).toBe(false);
		}
		for (const k of ["cmd+s", "cmd+shift+s", "esc", "enter", "cmd+a"])
			expect(isDangerousCombo(k)).toBeNull();
	});

	test("5b. desktop_act refuses shift+cmd+q, command+q and cmd+opt+esc before any screen or card", async () => {
		let asked = 0;
		registerTuiApprovalHandler(async () => {
			asked++;
			return "approve";
		});
		for (const keys of ["shift+cmd+q", "command+q", "cmd+opt+esc"]) {
			const calls = fresh();
			const r = await desktopAct(
				{ target: "the window", action: "press", keys },
				deps({ before }, calls),
				new DesktopActSession(),
			);
			expect(r.ok).toBe(false);
			expect(r.reason).toContain("Blocked");
			expect(calls.shots).toBe(0);
			expect(calls.pressed.length).toBe(0);
		}
		expect(asked).toBe(0);
	});
	test("6. the card cannot be rewritten by what it shows: escapes, controls and bidi are inert", async () => {
		const seen: string[] = [];
		registerTuiApprovalHandler(async (req) => {
			seen.push(req.command ?? "");
			return "deny";
		});
		const calls = fresh();
		// Cursor up + erase line (7-bit), C1 CSI, an OSC title set, a bidi override and a line separator.
		const hostile = "OK button\x1b[1A\x1b[2K\x9b2K\x1b]0;pwned\x07\u202e\u2028x";
		await desktopAct(
			{ target: hostile, action: "type", text: "a\x1b[2Kb\x9b1A\u202ec\u2028d" },
			deps({ before, after }, calls),
			new DesktopActSession(),
		);
		expect(seen.length).toBe(1);
		const card = seen[0];
		const lines = card.split("\n");
		expect(lines[0]).toBe("type OK buttonx");
		expect(lines).toContain('will type exactly: "a\\u001b[2Kb\\u009b1A\\u202ec\\u2028d"');
		// Outside the crop (which is ours), nothing a terminal would act on.
		const head = lines.slice(0, 4).join("\n");
		expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\u2028\u2029]/.test(head)).toBe(
			false,
		);
		expect(calls.typed.length).toBe(0);
	});

	test("6b. keys and a policy reason are cleaned the same way", () => {
		const req: DesktopActApproval = {
			action: "press",
			target: "editor",
			point: { x: 1, y: 2 },
			confidence: 0.9,
			attempt: 1,
			keys: "cmd+s\x1b[2K\u202e",
		} as DesktopActApproval;
		const card = desktopApprovalCard(req, "Rule says ask.\x1b[1A\x9b2K");
		expect(card.split("\n")).toEqual([
			"press editor",
			"at screen point (1, 2), grounder confidence 0.9",
			"keys: cmd+s",
			"Rule says ask.",
		]);
	});

	test("7. the policy gate (and so its audit) is never given the typed text", async () => {
		const ctxs: unknown[] = [];
		registerTuiApprovalHandler(async () => "approve");
		const calls = fresh();
		await desktopAct(
			{ target: "the search field", action: "type", text: "hunter2 secret" },
			deps(
				{
					before,
					after,
					policy: (ctx) => {
						ctxs.push(ctx);
						return evaluatePolicy("desktop_use", ctx);
					},
				},
				calls,
			),
			new DesktopActSession(),
		);
		expect(ctxs.length).toBeGreaterThan(0);
		expect(JSON.stringify(ctxs)).not.toContain("hunter2");
		expect(calls.typed).toEqual(["hunter2 secret"]);
	});

	test("8. hooks, events and the session file get the length; other tools pass through", () => {
		expect(
			loggableToolArgs("desktop_act", { target: "x", action: "type", text: "hunter2" }),
		).toEqual({
			target: "x",
			action: "type",
			textLength: 7,
		});
		expect(loggableToolArgs("desktop_type", { text: "hunter2" })).toEqual({ textLength: 7 });
		const other = { path: "a", text: "kept" };
		expect(loggableToolArgs("write_file", other)).toBe(other);
	});

	test("9. a plain terminal answers NO when stdin closes, and only y/yes is a yes", async () => {
		const sink = new PassThrough();
		const ended = new PassThrough();
		ended.end();
		expect(await askOnTerminal("card", ended, sink)).toBe(false);

		const closed = new PassThrough();
		const pending = askOnTerminal("card", closed, sink);
		closed.end("");
		expect(await pending).toBe(false);

		const yes = new PassThrough();
		const p2 = askOnTerminal("card", yes, sink);
		yes.write("y\n");
		expect(await p2).toBe(true);

		const other = new PassThrough();
		const p3 = askOnTerminal("card", other, sink);
		other.end("sure\n");
		expect(await p3).toBe(false);
	});
});
