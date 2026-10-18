import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import {
	chmodSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import * as fsModule from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { scrub as scrubSecrets } from "../../eight/secret-scanner";
import { ToolExecutor } from "../../eight/tools";
import {
	RESERVED_LOOPBACK_PORTS,
	_resetLoopbackAllowlistForTest,
} from "../../permissions/loopback-allowlist";
import { curlToLoopback } from "../../permissions/s1-curl-loopback";
import {
	type TuiApprovalDecision,
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../../permissions/tui-approval-channel";
import {
	type BrowserCall,
	type BrowserLaunchSpec,
	LOCAL_BROWSER_PROFILE,
	LOCAL_SERVER_CURL_NOTE,
	PROFILE_MIN_VERSION,
	_setAppDirsForTest,
	_setHostSandboxedForTest,
	_setKillForTest,
	_setLaunchWaitForTest,
	_setProfileHomeForTest,
	_setResolverForTest,
	_setSpawnForTest,
	blockedForProfile,
	browserBinary,
	browserProfile,
	browserProfileWarning,
	browserWithheldNote,
	compareVersions,
	createEightBrowser,
	launchLogTail,
	localBrowserTools,
	pngSize,
	resolveSecretText,
	resolveTaskFileField,
	secretsPathInHome,
	setDefaultLocalProfile,
	touchesBrowserSecrets,
	usingDefaultLocalProfile,
	validateBrowserAction,
	wsTransport,
} from "../eight-browser";

// A fake 8gent Browser control channel that behaves like the pilot fixture:
// a login form, then a settings page with a checkbox and a Save button.
function fakeSite(opts: { dropTyping?: boolean; prefilledPassword?: string } = {}) {
	const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
	let page: "login" | "settings" = "login";
	const values: Record<string, string> = {};
	if (opts.prefilledPassword) values["input[type=password]"] = opts.prefilledPassword;
	const closed: string[] = [];
	let checked = false;
	let saved = "off";
	const els = () =>
		page === "login"
			? [
					{
						index: 0,
						tag: "input",
						text: clip(values["input[name=username]"]),
						rect: { x: 0, y: 0, w: 9, h: 9 },
					},
					{
						index: 1,
						tag: "input",
						text: clip(values["input[type=password]"]),
						rect: { x: 0, y: 10, w: 9, h: 9 },
					},
					{ index: 2, tag: "button", text: "Sign in", rect: { x: 0, y: 20, w: 9, h: 9 } },
				]
			: [
					{ index: 0, tag: "input", text: "on", rect: { x: 0, y: 0, w: 9, h: 9 } },
					{ index: 1, tag: "button", text: "Save", rect: { x: 0, y: 10, w: 9, h: 9 } },
					{
						index: 2,
						tag: "button",
						text: "Delete account",
						rect: { x: 0, y: 20, w: 9, h: 9 },
						sel: "#danger",
					},
					{
						index: 3,
						tag: "button",
						text: "x",
						rect: { x: 0, y: 30, w: 9, h: 9 },
						sel: "#close",
						aria: "Remove widget",
					},
				];
	// page.query clips text the way 8gent Browser does: collapsed whitespace, 120 chars.
	function clip(v?: string) {
		return (v ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
	}
	const call: BrowserCall = async (cmd, args = {}) => {
		calls.push({ cmd, args });
		switch (cmd) {
			case "tab.open":
				return { id: "t1" };
			case "tab.close":
				closed.push(String(args.id));
				return { closed: args.id };
			case "nav.go":
				page = "login";
				return { navigating: args.url };
			case "page.read":
				return {
					snapshot: {
						url: page === "login" ? "http://127.0.0.1:5/" : "http://127.0.0.1:5/settings",
						title: "Dashboard",
						text: page === "login" ? "Sign in" : `Weekly digest is ${saved}.`,
					},
				};
			case "page.query": {
				const all = els();
				if (args.selector === ":checked") {
					const c = page === "settings" && checked ? [all[0]] : [];
					return { ok: true, elements: c, count: c.length };
				}
				if (args.selector === "input[type=password]" && page === "login")
					return { ok: true, elements: [all[1]], count: 1 };
				if (typeof args.selector === "string" && args.selector.startsWith("[aria-label*=")) {
					const q = String(args.selector).toLowerCase();
					const hits = all.filter(
						(e) =>
							"aria" in e &&
							e.aria &&
							e.aria
								.toLowerCase()
								.split(" ")
								.some((w) => q.includes(`"${w}"`)),
					);
					return { ok: true, elements: hits, count: hits.length };
				}
				const bySel = all.filter((e) => "sel" in e && e.sel === args.selector);
				if (bySel.length) return { ok: true, elements: bySel, count: 1 };
				if (typeof args.selector === "string" && args.selector.startsWith("input[")) {
					return {
						ok: true,
						elements: [{ index: 0, tag: "input", text: clip(values[args.selector as string]) }],
						count: 1,
					};
				}
				if (typeof args.selector === "string") return { ok: true, elements: [], count: 0 };
				return { ok: true, elements: all, count: all.length };
			}
			case "page.type":
				if (!opts.dropTyping) values[args.selector as string] = String(args.text);
				return { ok: true, typed: true };
			case "page.click": {
				const el =
					typeof args.index === "number"
						? els()[args.index]
						: els().find((e) => "sel" in e && e.sel === args.selector);
				if (!el) return { ok: false, error: "index out of range" };
				if (page === "login" && el.text === "Sign in") page = "settings";
				else if (page === "settings" && el.index === 0) checked = !checked;
				else if (page === "settings" && el.text === "Save") saved = checked ? "on" : "off";
				return { ok: true, clicked: true };
			}
			case "page.screenshot":
				return {
					ok: true,
					dataUrl: `data:image/png;base64,${pngHeader(640, 480).toString("base64")}`,
					savedTo: null,
				};
			case "page.waitFor":
				return { ok: true, found: true, waitedMs: 1 };
			default:
				throw new Error(`unexpected ${cmd}`);
		}
	};
	return { call, calls, closed, state: () => ({ page, saved, checked }) };
}

// Destination checks resolve names; keep every test off the real network.
_setResolverForTest(async () => [{ address: "93.184.216.34", family: 4 }]);
// A profile that is not running is launched on demand (#3785); no test may start the real app.
_setSpawnForTest(() => ({ exited: Promise.resolve("test spawn refused") }));

/** A PNG header (signature + IHDR) for a w x h image: enough for pngSize, as 8gent Browser's shots are. */
function pngHeader(w: number, h: number): Buffer {
	const b = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
	b.writeUInt32BE(13, 8);
	b.write("IHDR", 12, "latin1");
	b.writeUInt32BE(w, 16);
	b.writeUInt32BE(h, 20);
	return b;
}

// The default local profile is process state an in-process Agent turn in another test file can leave set.
beforeEach(() => setDefaultLocalProfile(null));

describe("validateBrowserAction (CUA action spec)", () => {
	test("accepts the closed vocabulary and rejects the rest", () => {
		expect(validateBrowserAction({ action: "left_click", index: 2 }).ok).toBe(true);
		expect(validateBrowserAction({ action: "type", selector: "input", text: "x" }).ok).toBe(true);
		expect(validateBrowserAction({ action: "eval", js: "1" })).toEqual({
			ok: false,
			error: "unknown action kind: eval",
		});
		expect(validateBrowserAction({ action: "left_click" }).ok).toBe(false);
		expect(
			validateBrowserAction({ action: "type", selector: "input", text: "x".repeat(4001) }).ok,
		).toBe(false);
		expect(validateBrowserAction({ action: "open", url: "file:///etc/passwd" }).ok).toBe(false);
	});
});

describe("8gent Browser driver", () => {
	test("signs in and flips the toggle with every step verified", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		const opened = await b.open("http://127.0.0.1:5/");
		expect(opened).toContain('"tab":"t1"');
		const asked: string[] = [];
		const approve = async (what: string) => {
			asked.push(what);
			return true;
		};
		const out = await b.run(
			[
				{ action: "type", selector: "input[name=username]", text: "rishi" },
				{ action: "type", selector: "input[type=password]", text: "s3cret-pass" },
				{ action: "left_click", index: 2 },
				{ action: "left_click", index: 0 },
				{ action: "left_click", index: 1 },
			],
			undefined,
			approve,
		);
		const res = JSON.parse(out);
		// "Sign in" is an authenticate click: it went to the approval gate, once.
		expect(asked).toEqual(['click "Sign in" (authenticate)']);
		expect(res.ok).toBe(true);
		// The checkbox click verifies through its checked state, not page text.
		expect(res.steps.map((s: { verified: boolean }) => s.verified)).toEqual([
			true,
			true,
			true,
			true,
			true,
		]);
		expect(site.state().saved).toBe("on");
		// Typed text never echoes back to the model or the log: length only.
		expect(out).not.toContain("s3cret-pass");
		expect(res.steps[1].text_len).toBe(11);
	});

	test("dry run refuses the whole plan before acting when a target is out of range", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const res = JSON.parse(
			await b.run([
				{ action: "type", selector: "input[name=username]", text: "a" },
				{ action: "left_click", index: 9 },
			]),
		);
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/dry run/);
		expect(site.calls.some((c) => c.cmd === "page.type" || c.cmd === "page.click")).toBe(false);
	});

	test("sensitive clicks go to the approval gate: by index, by selector, and by aria-label", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const yes = async () => true;
		await b.run([{ action: "left_click", index: 2 }], undefined, yes);
		const clicks = () => site.calls.filter((c) => c.cmd === "page.click").length;
		const asked: string[] = [];
		const no = async (what: string) => {
			asked.push(what);
			return false;
		};
		for (const a of [
			{ action: "left_click", index: 2 },
			{ action: "left_click", selector: "#danger" },
			{ action: "left_click", selector: "#close" },
		]) {
			const res = JSON.parse(await b.run([a], undefined, no));
			expect(res.ok).toBe(false);
			expect(res.error).toMatch(/declined/);
		}
		expect(asked).toEqual([
			'click "Delete account" (destructive)',
			'click "Delete account" (destructive)',
			'click "x" (destructive)',
		]);
		// With no approver at all, a sensitive click is refused, never run.
		expect(JSON.parse(await b.run([{ action: "left_click", index: 2 }])).error).toMatch(
			/needs approval/,
		);
		expect(clicks()).toBe(1);
		// A selector that matches nothing is refused before any click.
		expect(
			JSON.parse(await b.run([{ action: "left_click", selector: "#nope" }], undefined, yes)).error,
		).toMatch(/no element/);
		expect(clicks()).toBe(1);
	});

	test("closeAll closes every tab it opened", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		await b.closeAll();
		expect(site.closed).toEqual(["t1"]);
		expect(await b.state()).toMatch(/not opened by 8gent/);
	});

	test("verify-after-act retries a type that did not land, then stops the plan", async () => {
		const site = fakeSite({ dropTyping: true });
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const res = JSON.parse(
			await b.run([
				{ action: "type", selector: "input[name=username]", text: "rishi" },
				{ action: "left_click", index: 2 },
			]),
		);
		expect(res.ok).toBe(false);
		expect(res.steps[0]).toMatchObject({ verified: false, attempts: 2 });
		expect(site.calls.filter((c) => c.cmd === "page.click").length).toBe(0);
	});

	test("only drives tabs it opened", async () => {
		const b = createEightBrowser(fakeSite().call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		expect(await b.state("someone-elses-tab")).toMatch(/not opened by 8gent/);
	});

	test("a type verifies against 8gent Browser's clipped text, not the raw string", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const long = `  two  spaces ${"x".repeat(200)}`;
		const res = JSON.parse(
			await b.run([{ action: "type", selector: "input[name=username]", text: long }]),
		);
		expect(res.steps[0]).toMatchObject({ verified: true, attempts: 1 });
	});

	test("screenshot writes the tab's PNG to the requested path and reports '<path> WxH' (#3785)", async () => {
		const b = createEightBrowser(fakeSite().call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const out = join(mkdtempSync(join(tmpdir(), "8b-shot-")), "s.png");
		expect(await b.screenshot(out)).toBe(`${out} 640x480`);
		expect(readFileSync(out).equals(pngHeader(640, 480))).toBe(true);
		expect(await b.screenshot(out, "not-mine")).toMatch(/not opened by 8gent/);
	});
	test("screenshot: the size comes from the IHDR, else the reported viewport, else nothing is appended", () => {
		expect(pngSize(pngHeader(1280, 800))).toEqual({ w: 1280, h: 800 });
		expect(pngSize(Buffer.from("PNG"))).toBeNull();
		expect(pngSize(Buffer.from("not a png at all, but long enough to read"))).toBeNull();
	});
	test("screenshot without a path: the browser's own file, sized by its reported viewport", async () => {
		const site = fakeSite();
		const call: BrowserCall = async (cmd, args) =>
			cmd === "page.screenshot"
				? { ok: true, savedTo: "/tmp/8b/shot.png", viewport: { width: 1024, height: 768 } }
				: site.call(cmd, args);
		const b = createEightBrowser(call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		// The reported file comes back resolved for this OS: on Windows a rooted POSIX
		// spelling lands on the current drive (D:\tmp\8b\shot.png on the CI runner).
		expect(await b.screenshot()).toBe(`${resolve("/tmp/8b/shot.png")} 1024x768`);
	});
});

describe("state rendering", () => {
	test("a labelled input reads by its accessible name from the browser, never its value (#4043)", async () => {
		const pageQuery = {
			ok: true,
			elements: [
				{
					index: 0,
					tag: "input",
					role: "textbox",
					name: "Username",
					text: "pilot-user",
					visible: true,
				},
				{ index: 1, tag: "input", role: "textbox", name: "Password", text: "", visible: true },
				{
					index: 2,
					tag: "input",
					role: "checkbox",
					name: "Weekly digest",
					text: "on",
					visible: true,
				},
				{
					index: 3,
					tag: "button",
					role: "button",
					name: "Sign in",
					text: "Sign in",
					visible: true,
				},
			],
		};
		const selectorCalls: string[] = [];
		const call: BrowserCall = async (cmd, args = {}) => {
			if (cmd === "tab.open") return { id: "t9" };
			if (cmd === "page.read")
				return { snapshot: { url: "http://127.0.0.1:5/", title: "x", text: "" } };
			if (cmd === "page.query" && typeof args.selector === "string") {
				selectorCalls.push(args.selector);
				return { ok: true, elements: [] };
			}
			if (cmd === "page.query") return pageQuery;
			return { ok: true };
		};
		const b = createEightBrowser(call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		const out = await b.open("http://127.0.0.1:5/");
		expect(JSON.parse(out).elements).toEqual([
			'[0] textbox "Username"',
			'[1] textbox "Password"',
			'[2] checkbox "Weekly digest"',
			'[3] button "Sign in"',
		]);
		expect(out).not.toContain("pilot-user");
		// Role and name came from the browser, so no rect-matching role queries were made.
		expect(selectorCalls.some((sel) => sel.includes("[role=link]"))).toBe(false);
	});

	test("password fields are always masked, even when the agent did not type them", async () => {
		const b = createEightBrowser(fakeSite({ prefilledPassword: "autofilled-pw" }).call, {
			allowLoopback: ["127.0.0.1:5"],
			settleMs: 0,
		});
		const out = await b.open("http://127.0.0.1:5/");
		expect(out).not.toContain("autofilled-pw");
		expect(JSON.parse(out).elements[1]).toBe("[1] textbox (password field)");
	});

	test("typed values are never echoed back through the element list", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const out = await b.run([
			{ action: "type", selector: "input[type=password]", text: "s3cret-pass" },
		]);
		expect(out).not.toContain("s3cret-pass");
		expect(await b.state()).not.toContain("s3cret-pass");
		expect(JSON.parse(await b.state()).elements[1]).toBe("[1] textbox (password field)");
		const out2 = await b.run([
			{ action: "type", selector: "input[name=username]", text: "rishi-user" },
		]);
		expect(out2).not.toContain("rishi-user");
		expect(JSON.parse(await b.state()).elements[0]).toBe("[0] textbox (typed, 10 chars)");
	});

	test("hides invisible elements (a hidden csrf value never reaches the model) and keeps indices stable", async () => {
		const call: BrowserCall = async (cmd, args = {}) => {
			if (cmd === "tab.open") return { id: "t9" };
			if (cmd === "page.waitFor") return { ok: true, found: true };
			if (cmd === "page.read")
				return { snapshot: { url: "http://127.0.0.1:5/", title: "x", text: "" } };
			if (cmd === "page.query" && args.selector === "input[name=csrf]")
				return {
					ok: true,
					elements: [
						{ index: 0, tag: "input", text: "", visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } },
					],
				};
			if (cmd === "page.query" && typeof args.selector === "string")
				return { ok: true, elements: [] };
			return {
				ok: true,
				elements: [
					{ index: 0, tag: "input", text: "", visible: true },
					{
						index: 1,
						tag: "input",
						text: "csrf-secret-value",
						visible: false,
						rect: { x: 0, y: 0, w: 0, h: 0 },
					},
					{ index: 2, tag: "button", text: "Sign in", visible: true },
				],
			};
		};
		const out = await createEightBrowser(call, {
			settleMs: 0,
			allowLoopback: ["127.0.0.1:5"],
		}).open("http://127.0.0.1:5/");
		expect(out).not.toContain("csrf-secret-value");
		expect(JSON.parse(out).elements).toEqual(['[0] textbox ""', '[2] button "Sign in"']);
		const b2 = createEightBrowser(call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b2.open("http://127.0.0.1:5/");
		expect(JSON.parse(await b2.run([{ action: "left_click", index: 1 }])).error).toMatch(/hidden/);
		expect(
			JSON.parse(await b2.run([{ action: "left_click", selector: "input[name=csrf]" }])).error,
		).toMatch(/hidden/);
	});
});

// Skipped on Windows: every block that opens a real Bun.serve WebSocket server. The windows-latest
// run dies in this file: Bun 1.4.3 segfaults and 1.4.2 segfaults or hangs, at a different test each
// run, right after such a server is stopped, and every test after it in the process is lost.
// Cause not isolated; tracked in #3820. The driver logic is also covered by the in-process
// fakeSite() tests above, which still run on Windows.
const describeNotWin = process.platform === "win32" ? describe.skip : describe;
const testNotWin = process.platform === "win32" ? test.skip : test;

describeNotWin("wsTransport (real WebSocket round trip)", () => {
	test("authenticates with the token file, then sends the command and returns its result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "8b-ws-"));
		writeFileSync(join(dir, "token"), "tok-123\n");
		const seen: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
			websocket: {
				message(ws, raw) {
					const m = JSON.parse(String(raw));
					seen.push(m);
					let reply: unknown = { id: m.id, ok: true, result: { echoed: m.cmd, args: m.args } };
					if (m.type === "auth")
						reply =
							m.token === "tok-123" ? { type: "auth_ok" } : { type: "error", error: "bad token" };
					else if (m.cmd === "boom") reply = { id: m.id, ok: false, error: "nope" };
					else if (m.cmd === "hangup") return void ws.close();
					else if (m.cmd === "garbage") return void ws.send("{not json");
					ws.send(JSON.stringify(reply));
				},
			},
		});
		try {
			const call = wsTransport({ port: server.port, tokenFile: join(dir, "token") });
			expect(await call("tabs.list", { a: 1 })).toEqual({ echoed: "tabs.list", args: { a: 1 } });
			await expect(call("boom")).rejects.toThrow("nope");
			await expect(call("hangup")).rejects.toThrow(/closed/);
			await expect(call("garbage")).rejects.toThrow(/bad message/);
			expect(seen[0]).toEqual({ type: "auth", token: "tok-123" });
			const bad = wsTransport({ port: server.port, tokenFile: join(dir, "missing") });
			await expect(bad("tabs.list")).rejects.toThrow(/token not found/);
		} finally {
			server.stop(true);
		}
	});
});

describe("ToolExecutor gates browser_* (8SO review of #3592)", () => {
	const dir = mkdtempSync(join(tmpdir(), "browser-gate-"));
	const prevHeadless = process.env.EIGHT_HEADLESS;
	const prevPort = process.env.EIGHT_BROWSER_CONTROL_PORT;
	// A gate regression must never reach the person's real browser: point the driver at a dead port.
	beforeEach(() => {
		process.env.EIGHT_BROWSER_CONTROL_PORT = "9";
	});
	afterEach(() => {
		if (prevPort === undefined) Reflect.deleteProperty(process.env, "EIGHT_BROWSER_CONTROL_PORT");
		else process.env.EIGHT_BROWSER_CONTROL_PORT = prevPort;
		_resetTuiApprovalChannel();
		if (prevHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		else process.env.EIGHT_HEADLESS = prevHeadless;
	});
	const card = (answer: TuiApprovalDecision) => {
		const asked: TuiApprovalRequest[] = [];
		registerTuiApprovalHandler(async (req) => {
			asked.push(req);
			return answer;
		});
		return asked;
	};

	test("browser_task shows a Browser control card with typed text redacted; declined runs nothing", async () => {
		const asked = card("deny");
		const out = await new ToolExecutor(dir, "browser-gate-test").execute("browser_task", {
			actions: [{ action: "type", selector: "input[name=pw]", text: "hunter2-secret" }],
		});
		expect(asked.length).toBe(1);
		expect(asked[0].action).toBe("Browser control");
		expect(asked[0].details).toContain("browser_task");
		expect(asked[0].details).not.toContain("hunter2-secret");
		expect(out).toContain("[PERMISSION DENIED]");
	});

	test("browser_screenshot asks first too", async () => {
		const asked = card("deny");
		const out = await new ToolExecutor(dir, "browser-gate-test").execute("browser_screenshot", {});
		expect(asked.length).toBe(1);
		expect(out).toContain("[PERMISSION DENIED]");
	});

	test("with no one to ask, browser_task is blocked, not run", async () => {
		process.env.EIGHT_HEADLESS = "1";
		const out = await new ToolExecutor(dir, "browser-gate-test").execute("browser_task", {
			actions: [{ action: "scroll", dy: 10 }],
		});
		expect(out).toContain("[BLOCKED]");
	});

	test("browser_open is gated as network_request", async () => {
		const out = await new ToolExecutor(dir, "browser-gate-test").execute("browser_open", {
			url: "https://pastebin.com/raw/x",
		});
		expect(out).toMatch(/exfil/i);
		expect(out).not.toContain('"tab"');
	});

	test("browser_screenshot writes only a .png inside the workspace or ~/.8gent/browser-shots", async () => {
		card("approve");
		const exec = new ToolExecutor(dir, "browser-gate-test");
		expect(await exec.execute("browser_screenshot", { path: "/etc/evil.png" })).toMatch(
			/browser_screenshot failed: .*(outside|blocked)/i,
		);
		expect(await exec.execute("browser_screenshot", { path: "shot.jpg" })).toMatch(/\.png/);
	});
});

// ── Named profile (#3622): the bot's own login-free 8gent Browser ────────────

/** Serve a BrowserCall over a real token-gated WebSocket, like 8gent Browser's control server. */
function serveCall(call: BrowserCall, token: string) {
	const tokens: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 400 })),
		websocket: {
			async message(ws, raw) {
				const m = JSON.parse(String(raw));
				if (m.type === "auth") {
					tokens.push(m.token);
					return void ws.send(
						JSON.stringify(
							m.token === token ? { type: "auth_ok" } : { type: "error", error: "bad token" },
						),
					);
				}
				try {
					ws.send(JSON.stringify({ id: m.id, ok: true, result: await call(m.cmd, m.args) }));
				} catch (e) {
					ws.send(JSON.stringify({ id: m.id, ok: false, error: (e as Error).message }));
				}
			},
		},
	});
	return { server, tokens };
}

/** A temp HOME holding a running named profile's token and port files. */
function profileHome(name: string, files: { token?: string; port?: number | string }) {
	const home = mkdtempSync(join(tmpdir(), "8b-profile-"));
	const dir = join(home, ".8gent", "browser-profiles", name);
	mkdirSync(dir, { recursive: true });
	if (files.token !== undefined)
		writeFileSync(join(dir, "browser-control.token"), `${files.token}\n`);
	if (files.port !== undefined)
		writeFileSync(join(dir, "browser-control.port"), String(files.port));
	return home;
}

/** The secret-field probe 8gent Browser answers: `:is(<selector>):is(<password/payment fields>)`. */
const SECRET_TARGETS = ["input[type=password]", "input[autocomplete=cc-number]"];
function withSecretFields(call: BrowserCall): BrowserCall {
	return async (cmd, args = {}) => {
		const sel = typeof args.selector === "string" ? args.selector : "";
		if (cmd === "page.query" && sel.startsWith(":is(")) {
			const target = sel.slice(4, sel.indexOf("):is("));
			const hit = SECRET_TARGETS.includes(target);
			return {
				ok: true,
				elements: hit ? [{ index: 1, tag: "input", text: "" }] : [],
				count: hit ? 1 : 0,
			};
		}
		return call(cmd, args);
	};
}

/** One page, one harmless button: a click that is not sensitive and visibly changes the page. */
function nextSite() {
	let clicks = 0;
	const calls: string[] = [];
	const call: BrowserCall = async (cmd, args = {}) => {
		calls.push(cmd);
		switch (cmd) {
			case "tab.open":
				return { id: "t9" };
			case "tab.close":
				return { closed: args.id };
			case "page.waitFor":
				return { ok: true, found: true };
			case "page.read":
				return {
					snapshot: { url: "https://example.com/", title: "Example", text: `clicked ${clicks}` },
				};
			case "page.query":
				if (typeof args.selector === "string") return { ok: true, elements: [], count: 0 };
				return {
					ok: true,
					elements: [{ index: 0, tag: "button", text: "Next", rect: { x: 0, y: 0, w: 9, h: 9 } }],
				};
			case "page.click":
				clicks++;
				return { ok: true, clicked: true };
			case "page.type":
				return { ok: true, typed: true };
			default:
				throw new Error(`unexpected ${cmd}`);
		}
	};
	return { call, calls, clicks: () => clicks };
}

describe("browserProfile", () => {
	const HOME = "/Users/someone";
	test('unset, empty and "default" are the default profile', () => {
		for (const v of [undefined, "", "default"])
			expect(browserProfile({ EIGHT_BROWSER_PROFILE: v }, HOME)).toBeNull();
	});
	test("a named profile lives under ~/.8gent/browser-profiles/<name>, never at the default token", () => {
		const p = browserProfile({ EIGHT_BROWSER_PROFILE: "eightgent" }, HOME);
		const dir = join(HOME, ".8gent", "browser-profiles", "eightgent");
		expect(p).toEqual({
			name: "eightgent",
			tokenFile: join(dir, "browser-control.token"),
			portFile: join(dir, "browser-control.port"),
		});
		expect(p?.tokenFile).not.toBe(join(HOME, ".8gent", "browser-control.token"));
	});
	test("hostile names throw instead of falling back to the default profile", () => {
		for (const v of [
			"DEFAULT",
			"..",
			"../x",
			"/abs",
			"a/b",
			".hidden",
			"a.b",
			"x",
			"a".repeat(33),
			"1a",
			"-a",
			"has space",
		])
			expect(() => browserProfile({ EIGHT_BROWSER_PROFILE: v }, HOME)).toThrow(
				/EIGHT_BROWSER_PROFILE/,
			);
	});
});

describe("localBrowserTools (local sessions get a browser only with a named profile)", () => {
	test("none for the default profile or a bad name, all four for a named one", () => {
		expect(localBrowserTools({})).toEqual([]);
		expect(localBrowserTools({ EIGHT_BROWSER_PROFILE: "default" })).toEqual([]);
		expect(localBrowserTools({ EIGHT_BROWSER_PROFILE: "../x" })).toEqual([]);
		expect(localBrowserTools({ EIGHT_BROWSER_PROFILE: "eightgent" })).toEqual([
			"browser_open",
			"browser_state",
			"browser_task",
			"browser_screenshot",
		]);
	});
});

describe("browserWithheldNote (a withheld browser says why and how to get it, #3785)", () => {
	test("names the tools, the reason and EIGHT_BROWSER_PROFILE when none is configured", () => {
		const note = browserWithheldNote({}) ?? "";
		expect(note).toMatch(/browser_open/);
		expect(note).toMatch(/not offered/);
		expect(note).toMatch(/EIGHT_BROWSER_PROFILE/);
		expect(note).toMatch(/loopback|private/);
		expect(note).not.toContain("\u2014");
	});
	test("points at the curl rules instead of repeating them: the compact local prompt carries them now (#4034)", () => {
		const note = browserWithheldNote({}) ?? "";
		expect(note).not.toContain(LOCAL_SERVER_CURL_NOTE);
		expect(note).toContain("local-server curl rules");
	});
	test("the example curl in the note passes System One's loopback lane as written", () => {
		const example = /\((curl [^)]+)\)/.exec(LOCAL_SERVER_CURL_NOTE)?.[1];
		expect(example).toBeDefined();
		const ws = realpathSync(mkdtempSync(join(tmpdir(), "curl-note-")));
		// The lane refuses when a proxy variable or a curlrc could redirect curl; isolate both, as
		// permissions/s1-curl-loopback.test.ts does, so this checks the advice and not the runner.
		const keys = [
			"http_proxy",
			"https_proxy",
			"all_proxy",
			"HTTP_PROXY",
			"HTTPS_PROXY",
			"ALL_PROXY",
			"HOME",
			"CURL_HOME",
			"XDG_CONFIG_HOME",
		];
		const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
		for (const k of keys) Reflect.deleteProperty(process.env, k);
		process.env.HOME = ws;
		try {
			const cmd = (example as string).replace("URL", "http://127.0.0.1:5173/login");
			expect(curlToLoopback(cmd, ws).ok).toBe(true);
			// The /tmp form the model kept choosing in the pilot does not pass; that is why the note says so.
			expect(curlToLoopback("curl -s -c /tmp/cj.txt http://127.0.0.1:5173/", ws).ok).toBe(false);
		} finally {
			for (const k of keys) {
				if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
				else process.env[k] = saved[k];
			}
			rmSync(ws, { recursive: true, force: true });
		}
	});
	test("a bad profile name is still withheld; a valid one offers the tools so no note", () => {
		expect(browserWithheldNote({ EIGHT_BROWSER_PROFILE: "../x" })).not.toBeNull();
		expect(browserWithheldNote({ EIGHT_BROWSER_PROFILE: "eightgent" })).toBeNull();
	});
});

describeNotWin("wsTransport with a named profile", () => {
	afterEach(() => _setProfileHomeForTest(null));

	test("uses the profile's own token and port file, not the default token or EIGHT_BROWSER_CONTROL_PORT", async () => {
		const { server, tokens } = serveCall(nextSite().call, "bot-tok");
		try {
			_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: server.port }));
			const call = wsTransport({
				env: { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_CONTROL_PORT: "9" },
			});
			expect(await call("tab.open", { url: "https://example.com/" })).toEqual({ id: "t9" });
			expect(tokens).toEqual(["bot-tok"]);
		} finally {
			server.stop(true);
		}
	});

	// Rule since #3785: a profile with no port file is started on demand, once per process. When that
	// start fails (here: the spawn seam refuses), the call fails closed with the launch reason and the
	// curl alternative, never by connecting to the default browser. A port file with no token file is
	// still "not running": nothing is launched over a half-published profile.
	test("fails closed, without connecting, when the profile is not running and cannot be started", async () => {
		// Other files in one bun process reset the module-level spawn seam; pin it here (the full CI run saw it unset).
		_setSpawnForTest(() => ({ exited: Promise.resolve("test spawn refused") }));
		// The spawn seam must be reached: on a sandboxed dev Mac the #4099 pre-flight would answer first.
		_setHostSandboxedForTest(false);
		try {
			// A binary path must resolve or the launch fails earlier with "no app found" (always on Linux, where no
			// app bundle is searched); the spawn seam never runs it.
			const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
			_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok" }));
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
				/8gent Browser could not start \(test spawn refused\).*run_command with curl/,
			);
			_setProfileHomeForTest(profileHome("eightgent", { port: 7981 }));
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
				/profile "eightgent" is not running/,
			);
		} finally {
			_setHostSandboxedForTest(null);
		}
	});

	test("refuses a port file that points at the default profile's port 7980, or junk", async () => {
		const env = { EIGHT_BROWSER_PROFILE: "eightgent" };
		for (const port of [7980, "abc", 0]) {
			_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port }));
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(/port/);
		}
	});

	test("a bad profile name is an error, never the default browser", async () => {
		await expect(
			wsTransport({ env: { EIGHT_BROWSER_PROFILE: "../x" } })("tabs.list"),
		).rejects.toThrow(/EIGHT_BROWSER_PROFILE/);
	});
});

describe("isolated driver (named profile): no typing into password or payment fields", () => {
	test("a password field is refused in the dry run: nothing is typed, not even earlier steps", async () => {
		const site = fakeSite();
		const b = createEightBrowser(withSecretFields(site.call), {
			settleMs: 0,
			isolated: true,
		});
		await b.open("https://example.com/");
		const out = JSON.parse(
			await b.run([
				{ action: "type", selector: "input[name=username]", text: "bot" },
				{ action: "type", selector: "input[type=password]", text: "hunter2" },
			]),
		);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/step 1: .*password or payment field/);
		expect(site.calls.some((c) => c.cmd === "page.type")).toBe(false);
	});

	test("a payment field is refused too", async () => {
		const site = fakeSite();
		const b = createEightBrowser(withSecretFields(site.call), {
			settleMs: 0,
			isolated: true,
		});
		await b.open("https://example.com/");
		const out = JSON.parse(
			await b.run([
				{ action: "type", selector: "input[autocomplete=cc-number]", text: "4242424242424242" },
			]),
		);
		expect(out.ok).toBe(false);
		expect(site.calls.some((c) => c.cmd === "page.type")).toBe(false);
	});

	test("ordinary fields still type", async () => {
		const site = fakeSite();
		const b = createEightBrowser(withSecretFields(site.call), {
			settleMs: 0,
			isolated: true,
		});
		await b.open("https://example.com/");
		const out = JSON.parse(
			await b.run([{ action: "type", selector: "input[name=username]", text: "bot" }]),
		);
		expect(out.ok).toBe(true);
	});
});

describeNotWin(
	"ToolExecutor: named profile acts without a card; default profile still asks",
	() => {
		const dir = mkdtempSync(join(tmpdir(), "browser-profile-gate-"));
		const saved = {
			profile: process.env.EIGHT_BROWSER_PROFILE,
			port: process.env.EIGHT_BROWSER_CONTROL_PORT,
			headless: process.env.EIGHT_HEADLESS,
		};
		const restore = (k: string, v: string | undefined) =>
			v === undefined ? Reflect.deleteProperty(process.env, k) : (process.env[k] = v);
		afterEach(() => {
			restore("EIGHT_BROWSER_PROFILE", saved.profile);
			restore("EIGHT_BROWSER_CONTROL_PORT", saved.port);
			restore("EIGHT_HEADLESS", saved.headless);
			_setProfileHomeForTest(null);
			_resetTuiApprovalChannel();
		});
		const recordAsks = () => {
			const asked: TuiApprovalRequest[] = [];
			registerTuiApprovalHandler(async (req) => {
				asked.push(req);
				return "deny";
			});
			return asked;
		};

		test("named profile: a click goes through with no approval call, even headless", async () => {
			const site = nextSite();
			const { server } = serveCall(withSecretFields(site.call), "bot-tok");
			try {
				_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: server.port }));
				process.env.EIGHT_BROWSER_PROFILE = "eightgent";
				process.env.EIGHT_BROWSER_CONTROL_PORT = "9"; // ignored: the profile's port file wins
				process.env.EIGHT_HEADLESS = "1";
				const asked = recordAsks();
				const exec = new ToolExecutor(dir, "browser-profile-gate");
				expect(await exec.execute("browser_open", { url: "https://example.com/" })).toContain(
					'"tab":"t9"',
				);
				const out = JSON.parse(
					await exec.execute("browser_task", { actions: [{ action: "left_click", index: 0 }] }),
				);
				expect(out.ok).toBe(true);
				expect(site.clicks()).toBe(1);
				expect(asked.length).toBe(0);
			} finally {
				server.stop(true);
			}
		});

		test("named profile: a password field is still refused", async () => {
			const site = fakeSite();
			const { server } = serveCall(withSecretFields(site.call), "bot-tok");
			try {
				_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: server.port }));
				process.env.EIGHT_BROWSER_PROFILE = "eightgent";
				process.env.EIGHT_HEADLESS = "1";
				const exec = new ToolExecutor(dir, "browser-profile-gate");
				await exec.execute("browser_open", { url: "https://example.com/" });
				const out = await exec.execute("browser_task", {
					actions: [{ action: "type", selector: "input[type=password]", text: "hunter2" }],
				});
				expect(out).toMatch(/password or payment field/);
				expect(site.calls.some((c) => c.cmd === "page.type")).toBe(false);
			} finally {
				server.stop(true);
			}
		});

		test("named profile: a sensitive click still needs approval (and headless means refused)", async () => {
			const site = fakeSite();
			const { server } = serveCall(withSecretFields(site.call), "bot-tok");
			try {
				_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: server.port }));
				process.env.EIGHT_BROWSER_PROFILE = "eightgent";
				process.env.EIGHT_HEADLESS = "1";
				const exec = new ToolExecutor(dir, "browser-profile-gate");
				await exec.execute("browser_open", { url: "https://example.com/" });
				const out = JSON.parse(
					await exec.execute("browser_task", { actions: [{ action: "left_click", index: 2 }] }),
				);
				expect(out.ok).toBe(false);
				expect(out.error).toMatch(/Sign in.*(declined|approval)/);
				expect(site.calls.some((c) => c.cmd === "page.click")).toBe(false);
			} finally {
				server.stop(true);
			}
		});

		for (const v of [undefined, "default"]) {
			test(`default profile (EIGHT_BROWSER_PROFILE=${v}): the same click still asks first`, async () => {
				restore("EIGHT_BROWSER_PROFILE", v);
				process.env.EIGHT_BROWSER_CONTROL_PORT = "9"; // never the person's real browser
				const asked = recordAsks();
				const out = await new ToolExecutor(dir, "browser-profile-gate").execute("browser_task", {
					actions: [{ action: "left_click", index: 0 }],
				});
				expect(asked.length).toBe(1);
				expect(asked[0].action).toBe("Browser control");
				expect(out).toContain("[PERMISSION DENIED]");
			});
		}
	},
);

// ── 8PO + 8SO review round ───────────────────────────────────────────────────

describe("secret-field check fails closed", () => {
	const probe = (answer: unknown): BrowserCall => {
		const site = fakeSite();
		return async (cmd, args = {}) => {
			if (
				cmd === "page.query" &&
				typeof args.selector === "string" &&
				args.selector.startsWith(":is(")
			)
				return answer;
			return site.call(cmd, args);
		};
	};
	for (const [label, answer] of [
		["ok:false (malformed selector)", { ok: false, error: "SyntaxError" }],
		["no elements array", { ok: true }],
		["elements not an array", { ok: true, elements: "x" }],
		["null reply", null],
	] as const) {
		test(`${label}: refused, nothing typed`, async () => {
			const calls: string[] = [];
			const inner = probe(answer);
			const call: BrowserCall = async (cmd, args) => {
				calls.push(cmd);
				return inner(cmd, args);
			};
			const b = createEightBrowser(call, { settleMs: 0, isolated: true });
			await b.open("http://example.com/");
			const out = JSON.parse(
				await b.run([{ action: "type", selector: 'input[type="password', text: "hunter2" }]),
			);
			expect(out.ok).toBe(false);
			expect(calls).not.toContain("page.type");
		});
	}
});

describe("named profile: no loopback or private hosts from the client either", () => {
	const at = (scheme: string, rest: string) => `${scheme}:/` + `/${rest}`;
	test("validateBrowserAction refuses private, userinfo and non-http URLs only when isolated", () => {
		for (const u of [
			at("http", "127.0.0.1:7981/"),
			at("http", "2130706433/"),
			at("http", "0x7f000001/"),
			at("http", "0177.0.0.1/"),
			at("http", "[::ffff:127.0.0.1]/"),
			at("http", "[::1]/"),
			at("http", "localhost:18789/"),
			at("http", "printer.local/"),
			at("http", "10.1.2.3/"),
			at("http", "172.20.0.1/"),
			at("http", "192.168.0.1/"),
			at("http", "169.254.169.254/"),
			at("http", "100.100.100.100/"),
			at("https", "user:pass@127.0.0.1/"),
			at("https", "example.com@127.0.0.1/"),
			at("https", "user@example.com/"),
		]) {
			expect(validateBrowserAction({ action: "open", url: u }, { isolated: true }).ok).toBe(false);
		}
		expect(
			validateBrowserAction(
				{ action: "open", url: at("https", "example.com/") },
				{ isolated: true },
			).ok,
		).toBe(true);
		// Default profile: unchanged (the pilot fixtures run on 127.0.0.1).
		expect(validateBrowserAction({ action: "open", url: at("http", "127.0.0.1:5/") }).ok).toBe(
			true,
		);
	});
	test("the isolated driver refuses browser_open and an open step to a private host before calling the browser", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, { settleMs: 0, isolated: true });
		expect(await b.open(at("http", "127.0.0.1:7980/"))).toMatch(/browser_open failed: .*private/);
		expect(site.calls).not.toContain("tab.open");
		await b.open(at("https", "example.com/"));
		const out = JSON.parse(await b.run([{ action: "open", url: at("http", "192.168.1.1/") }]));
		expect(out.ok).toBe(false);
		expect(site.calls).not.toContain("nav.go");
	});
});

describe("browser-use backend never gets the named-profile exemptions", () => {
	test("localBrowserTools offers nothing with EIGHT_BROWSER_BACKEND=browser-use", () => {
		expect(
			localBrowserTools({
				EIGHT_BROWSER_PROFILE: "eightgent",
				EIGHT_BROWSER_BACKEND: "browser-use",
			}),
		).toEqual([]);
	});
	test("browserProfileWarning: one line for a bad name, nothing otherwise", () => {
		expect(browserProfileWarning({})).toBeNull();
		expect(browserProfileWarning({ EIGHT_BROWSER_PROFILE: "eightgent" })).toBeNull();
		expect(browserProfileWarning({ EIGHT_BROWSER_PROFILE: "../x" })).toMatch(
			/EIGHT_BROWSER_PROFILE.*no browser/,
		);
	});
});

describe("ToolExecutor, review round", () => {
	const dir = mkdtempSync(join(tmpdir(), "browser-review-"));
	const keys = [
		"EIGHT_BROWSER_PROFILE",
		"EIGHT_BROWSER_CONTROL_PORT",
		"EIGHT_HEADLESS",
		"EIGHT_BROWSER_BACKEND",
	];
	const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
	afterEach(() => {
		for (const k of keys)
			saved[k] === undefined ? Reflect.deleteProperty(process.env, k) : (process.env[k] = saved[k]);
		_setProfileHomeForTest(null);
		_resetTuiApprovalChannel();
	});
	const recordAsks = () => {
		const asked: TuiApprovalRequest[] = [];
		registerTuiApprovalHandler(async (req) => {
			asked.push(req);
			return "deny";
		});
		return asked;
	};

	test("named profile + browser-use backend: browser_task still asks first", async () => {
		_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: 7981 }));
		process.env.EIGHT_BROWSER_PROFILE = "eightgent";
		process.env.EIGHT_BROWSER_BACKEND = "browser-use";
		const asked = recordAsks();
		const out = await new ToolExecutor(dir, "browser-review").execute("browser_task", {
			task: "x",
		});
		expect(asked.length).toBe(1);
		expect(out).toContain("[PERMISSION DENIED]");
	});

	testNotWin(
		"named profile: the sensitive-click card does not say 'your logged-in browser'",
		async () => {
			const site = fakeSite();
			const { server } = serveCall(withSecretFields(site.call), "bot-tok");
			try {
				_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: server.port }));
				process.env.EIGHT_BROWSER_PROFILE = "eightgent";
				const asked = recordAsks();
				const exec = new ToolExecutor(dir, "browser-review");
				await exec.execute("browser_open", { url: "https://example.com/" });
				await exec.execute("browser_task", { actions: [{ action: "left_click", index: 2 }] });
				expect(asked.length).toBe(1);
				expect(asked[0].details).not.toMatch(/logged-in/);
				expect(asked[0].details).toMatch(/bot's own browser profile/);
			} finally {
				server.stop(true);
			}
		},
	);

	testNotWin(
		"named profile: a screenshot is saved in the workspace, never in the protected profile dir",
		async () => {
			const site = nextSite();
			const shot: BrowserCall = async (cmd, args) =>
				cmd === "page.screenshot"
					? {
							ok: true,
							dataUrl: `data:image/png;base64,${pngHeader(320, 200).toString("base64")}`,
							savedTo: "/x/.8gent/browser-profiles/eightgent/browser-shots/a.png",
						}
					: site.call(cmd, args);
			const { server } = serveCall(shot, "bot-tok");
			try {
				_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: server.port }));
				process.env.EIGHT_BROWSER_PROFILE = "eightgent";
				process.env.EIGHT_HEADLESS = "1";
				const exec = new ToolExecutor(dir, "browser-review");
				await exec.execute("browser_open", { url: "https://example.com/" });
				const out = await exec.execute("browser_screenshot", {});
				expect(out.startsWith(dir)).toBe(true);
				expect(out).not.toContain("browser-profiles");
				expect(out.endsWith(" 320x200")).toBe(true);
				expect(readFileSync(out.slice(0, -" 320x200".length)).equals(pngHeader(320, 200))).toBe(
					true,
				);
			} finally {
				server.stop(true);
			}
		},
	);
});

// ── 8SO HIGH-2 follow-up: run_command backstop (a speed bump until #3612 seatbelts it) ──

describe("touchesBrowserSecrets: run_command may not reach the browser token or profiles", () => {
	const b64 = (t: string) => Buffer.from(t).toString("base64");
	const hex = (t: string) => Buffer.from(t).toString("hex");
	const refused = [
		"cat ~/.8gent/browser-shots/last.png",
		"cat /Users/x/.8gent/browser-shots/last.png",
		"cat ~/.8gent/browser-history.json",
		"cat ~/.8gent/./browser-history.json",
		"cat ~/.8gent/x/../browser-shots/last.png",
		"echo .8gent; cat ~/.8gent/browser-history.json",
		"cd ~/.8gent && cat ./browser-history.json",
		"cd ~/.8gent/rishi-pilot && cat ../browser-history.json",
		"ln -s ~/.8gent l && cat l/browser-history.json",
		"cat ~/.8gent/rishi-pilot/runs/x/browser-op-practice/../../../../browser-history.json",
		"cat ~/.8gent//browser-shots/a",
		"cat ~/.8gent/%62rowser-history.json",
		"cat ~/.8gent/browser-control.token",
		"cat $HOME/.8gent/browser-control.token",
		"cat /Users/someone/.8gent/browser-profiles/eightgent/browser-control.token",
		"cd ~/.8gent && cat browser-control.token",
		"ls ~/.8gent/browser-profiles",
		"cat ~/.8gent/*",
		"cat $HOME/.8gent/*",
		"cat ~/.8gent/browser-c*",
		"cat ~/.8gent/b?owser-control.token",
		"cat ~/.8*/b*",
		"cat ~/.?gent/[b]rowser-control.token",
		"cat ~/.{8,9}gent/x",
		"find ~ -name 'browser-*'",
		"find ~ -name 'b*'",
		"grep -r 'b*' ~/.8*/",
		"grep -r --include='*.token' . ~",
		"grep -rhg '*.token' 'x' ~",
		"grep -rlg '*.token' . ~",
		"grep -r -- '*.token' ~",
		"rg -g '*control*' 'x' ~",
		"grep -e '*.token' -r ~",
		"grep -r 'x' ~/.8gent",
		"grep --recursive x ~/.8gent",
		"grep --dereference-recursive x ~/.8gent",
		"grep -d recurse x ~/.8gent",
		"grep --directories=recurse x ~/.8gent",
		"rg x ~/.8gent",
		"grep -r 'x' ~/.?gent",
		"grep -rh --include='*.token' '' ~",
		"rg --hidden -g '*.token' . ~",
		`awk 'BEGIN{system("find ~ -name *.token -exec cat {} +")}'`,
		"sed -n '1e find ~ -name *.tok* -exec cat {} +' f",
		"grep . $(find ~ -name '*.token')",
		"echo ok; find ~ -name 'b*'",
		'cat ~/".8"gent/browser-control.token',
		"cat ~/'.8gent'/'browser'-'control'.token",
		"cat ~/.8gent/browser-control.token",
		"cat $'\x7e/\x2e8gent/browser-control.token'",
		"X=control; cat ~/.8gent/browser-$X.token",
		"D=.8gent; cat ~/$D/browser-control.token",
		`bun -e "console.log(require('fs').readFileSync(require('os').homedir()+'/.8gent/browser-control.token','utf8'))"`,
		`node -e "const f=require('fs');console.log(f.readFileSync(process.env.HOME+'/.8gent/browser-'+'control.token','utf8'))"`,
		`python3 -c "print(open(__import__('os').path.expanduser('~/.8gent/browser-control.token')).read())"`,
		`python -c "import os;print([f for f in os.listdir(os.path.expanduser('~/.8gent'))])"`,
		`bun -e "for (const f of require('fs').readdirSync(require('os').homedir()+'/.8gent')) if (f.endsWith('.token')) console.log(f)"`,
		`echo ${b64("~/.8gent/browser-control.token")} | base64 -d | xargs cat`,
		`cat $(echo ${hex("/Users/someone/.8gent/browser-control.token")} | xxd -r -p)`,
		`bun -e "console.log(require('fs').readFileSync(Buffer.from('${b64("/Users/someone/.8gent/browser-control.token")}','base64').toString()))"`,
		`python3 -c "import base64,os;print(open(base64.b64decode('${b64("/Users/someone/.8gent/browser-control.token")}')).read())"`,
		`node -e "const p=String.fromCharCode(${[..."/Users/someone/.8gent"].map((c) => c.charCodeAt(0)).join(",")});console.log(require('fs').readdirSync(p))"`,
	];
	for (const cmd of refused)
		test(`refuses: ${cmd.slice(0, 90)}`, () => expect(touchesBrowserSecrets(cmd)).toBe(true));

	const allowed = [
		"ls -la",
		"cat README.md",
		"bun test packages/tools",
		"git status",
		"ls *.ts",
		"cat ~/.8gent/settings.example",
		"echo hello | base64",
		"grep -r browser packages/tools",
		'node -e "console.log(1+1)"',
		// #3589: pulling a csrf token out of a login page is not a glob over the token file
		"grep -o 'name=csrf value=[a-f0-9]*' page.html",
		"curl -s -c jar.txt http://127.0.0.1:8080/ | grep -o 'value=[a-f0-9]*'",
		// pilot run dir lives under ~/.8gent and is named after the scenario
		"curl -s -m 10 -c /Users/x/.8gent/rishi-pilot/runs/2026-10-11_194806/browser-op-practice/work/cookie.txt -o /Users/x/.8gent/rishi-pilot/runs/2026-10-11_194806/browser-op-practice/work/login.html http://127.0.0.1:57420/",
	];
	for (const cmd of allowed)
		test(`allows: ${cmd}`, () => expect(touchesBrowserSecrets(cmd)).toBe(false));
});

describe("touchesBrowserSecrets: a scratch login file and sed regexes are not browser state (#4417)", () => {
	const scratch = [
		"sed -n 's/^\\([A-Za-z]*:\\).*/\\1/p' .tmp/login",
		"sed -n 's/^Password: */password=/w .tmp/login' TASK.txt",
		"cat .tmp/login",
		"sed -n 's/.*/x/p' login.txt",
	];
	for (const cmd of scratch)
		test(`allows: ${cmd}`, () => expect(touchesBrowserSecrets(cmd)).toBe(false));
	const real = [
		"cat ~/.8gent/browser-control.token",
		"sed -n p ~/.8gent/browser-control.token",
		"sed -n 's/a/b/w ~/.8gent/browser-control.token' x",
		"sed -n 's/a/b/p' ~/.8gent/browser-profiles/default/Cookies",
		"sed p .*",
		"cat ~/.8gent/browser-co*",
	];
	for (const cmd of real)
		test(`still refuses: ${cmd}`, () => expect(touchesBrowserSecrets(cmd)).toBe(true));
	// The s/// flags class is [gipIm0-9]: a GNU e (execute) or w (write file) flag is never blanked, so
	// the `.*` regex is read as a glob and the command stays denied. With p it is blanked and allowed.
	test("sed e and w flags are judged as written, not blanked", () => {
		expect(touchesBrowserSecrets("sed -n 's/.*/x/p' x")).toBe(false);
		expect(touchesBrowserSecrets("sed -n 's/.*/id/e' x")).toBe(true);
		expect(touchesBrowserSecrets("sed -n 's/.*/x/wout' x")).toBe(true);
		expect(touchesBrowserSecrets("sed -n 's/a/b/w ~/.8gent/browser-control.token'")).toBe(true);
	});
});

describe("touchesBrowserSecrets: a browser-named run dir and a listing deeper inside .8gent are not secrets (8SO, after #3950)", () => {
	const run = "/Users/x/.8gent/rishi-pilot/runs/2026-10-12_101500/browser-op-practice";
	const allowed = [
		`ls ${run}`,
		`ls -la ${run}`,
		`ls ${run}/work`,
		`find ${run} -name result.json`,
		"ls ~/.8gent/rishi-pilot/runs",
		"ls -la /Users/x/.8gent/rishi-pilot/runs/2026-10-12_101500",
		"cd ~/.8gent/runs; cat browser-op-practice/TASK.txt",
		"cd ~/.8gent/rishi-pilot/runs; ls",
		"cd ~/.8gent/rishi-pilot/runs; ls browser-op-practice",
		"cd ~/.8gent/runs && cat browser-op-practice/TASK.txt",
		"cat ~/.8gent/runs/browser-op-practice/TASK.txt",
		"cat browser-op-practice/TASK.txt",
		"grep -r TODO ~/.8gent/rishi-pilot/runs/2026-10-12_101500",
		"rg result ~/.8gent/rishi-pilot/runs",
		`python3 -c "import os;print(os.listdir(os.path.expanduser('~/.8gent/rishi-pilot/runs')))"`,
	];
	for (const cmd of allowed)
		test(`allows: ${cmd}`, () => expect(touchesBrowserSecrets(cmd)).toBe(false));

	// Every shape the narrowed lines still refuse: the state names without .8gent, and a listing of
	// .8gent itself or of a browser-* child, in every spelling that normalises to one.
	const refused = [
		"cd ~/.8gent && cat ./browser-history.json",
		"cd ~/.8gent/rishi-pilot && cat ../browser-history.json",
		"cd ~/.8gent/runs; cat ../browser-control.token",
		"cd ~/.8gent/runs; cat ../browser-shots/last.png",
		"cd ~/.8gent/runs; ls ../browser-profiles",
		"ln -s ~/.8gent l && cat l/browser-history.json",
		"ln -s ~/.8gent l && cat l/browser-control.port",
		"ls ~/.8gent",
		"ls ~/.8gent/",
		"ls -la ~/.8gent",
		"ls ~/.8gent/.",
		"ls ~/.8gent/rishi-pilot/..",
		"ls ~/.8gent/rishi-pilot/../",
		"ls ~/.8gent//",
		"ls /Users/x/.8gent",
		"find ~/.8gent -name x",
		"find ~/.8gent/rishi-pilot/.. -name x",
		"ls ~/.8gent/browser-profiles",
		"ls ~/.8gent/browser-profiles/eightgent",
		"ls ~/.8gent/browser-shots",
		"find ~/.8gent/browser-shots -name '*.png'",
		"grep -r x ~/.8gent",
		"grep -r x ~/.8gent/",
		"rg x ~/.8gent",
		"cd ~/.8gent; ls",
		"cd ~/.8gent/rishi-pilot/runs; ls ../..",
		"cd ~/.8gent/runs; ls ..",
		"cd ~/.8gent/runs; cd ..; ls",
		"cd ~/.8gent/runs && find .. -name x",
		"cat ~/.8gent/rishi-pilot/runs/x/browser-op-practice/../../../../browser-history.json",
		`python -c "import os;print(os.listdir(os.path.expanduser('~/.8gent')))"`,
		`python -c "import os;print(os.listdir(os.path.expanduser('~/.8gent/')))"`,
		`bun -e "console.log(require('fs').readdirSync(require('os').homedir()+'/.8gent'))"`,
		`bun -e "console.log(require('fs').readdirSync(require('os').homedir()+'/.8gent/browser-profiles'))"`,
		`node -e "console.log(require('fs').readdirSync(process.env.HOME+'/.8gent/rishi-pilot/..'))"`,
	];
	for (const cmd of refused)
		test(`refuses: ${cmd.slice(0, 90)}`, () => expect(touchesBrowserSecrets(cmd)).toBe(true));
});

describe("ToolExecutor.runCommand refuses browser-secret commands before anything runs", () => {
	test("cat, bun -e, python -c and node -e are all denied", async () => {
		const exec = new ToolExecutor(mkdtempSync(join(tmpdir(), "rc-guard-")), "rc-guard");
		for (const cmd of [
			"cat ~/.8gent/browser-control.token",
			`bun -e "require('fs').readFileSync(require('os').homedir()+'/.8gent/browser-control.token')"`,
			`python3 -c "open(__import__('os').path.expanduser('~/.8gent/browser-profiles/eightgent/browser-control.token')).read()"`,
			`node -e "require('fs').readdirSync(process.env.HOME+'/.8gent')"`,
		]) {
			const out = await exec.runCommand(cmd);
			expect(out).toMatch(
				/^\[PERMISSION DENIED\] Not run: refused by policy, nothing was checked or changed\. Command touches 8gent Browser control tokens/,
			);
		}
	});
});

describe("defence in depth: with EIGHT_BROWSER_PROFILE set, never the default browser", () => {
	afterEach(() => _setProfileHomeForTest(null));
	test("an explicit default port or default token is refused when a named profile is configured", async () => {
		const env = { EIGHT_BROWSER_PROFILE: "eightgent" };
		_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok", port: 7981 }));
		await expect(wsTransport({ env, port: 7980 })("tabs.list")).rejects.toThrow(/7980/);
		await expect(
			wsTransport({ env, tokenFile: "/Users/someone/.8gent/browser-control.token" })("tabs.list"),
		).rejects.toThrow(/default/);
	});
	test("an invalid profile name is refused, never the default", async () => {
		await expect(
			wsTransport({ env: { EIGHT_BROWSER_PROFILE: "BAD" }, port: 7980 })("tabs.list"),
		).rejects.toThrow(/EIGHT_BROWSER_PROFILE/);
	});
});

describe("blockedForProfile: trailing dots and IPv6-embedded IPv4", () => {
	const at = (scheme: string, rest: string) => `${scheme}:/` + `/${rest}`;
	for (const rest of [
		"localhost./",
		"127.0.0.1./",
		"printer.local./",
		"10.0.0.1./",
		"[::7f00:1]/",
		"[::127.0.0.1]/",
		"[::a00:1]/",
		"[64:ff9b::7f00:1]/",
		"[::ffff:0:7f00:1]/",
	])
		test(`refuses ${rest}`, () => expect(blockedForProfile(at("http", rest))).toMatch(/private/));
	test("public names with a trailing dot pass", () =>
		expect(blockedForProfile(at("https", "example.com./"))).toBeNull());
});

describe("browser destinations go through the net guard in every profile (#3603)", () => {
	const at = (scheme: string, rest: string) => `${scheme}:/` + `/${rest}`;
	const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];
	test("browser_open refuses metadata, LAN and unlisted loopback before calling the browser", async () => {
		for (const u of [
			at("http", "169.254.169.254/latest/meta-data/"),
			at("http", "192.168.1.1/"),
			at("http", "10.0.0.5/"),
			at("http", "127.0.0.1:9999/"),
			at("http", "localhost:5/"),
			at("http", "metadata.google.internal/"),
		]) {
			const site = nextSite();
			const b = createEightBrowser(site.call, {
				settleMs: 0,
				allowLoopback: ["127.0.0.1:5"],
				resolve: publicDns,
			});
			expect(await b.open(u)).toMatch(/browser_open failed: .*Refused/);
			expect(site.calls).not.toContain("tab.open");
		}
	});
	test("a name that resolves to a private address is refused", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			resolve: async () => [{ address: "192.168.1.1", family: 4 as const }],
		});
		expect(await b.open(at("https", "rebind.example.com/"))).toMatch(/Refused/);
		expect(site.calls).not.toContain("tab.open");
	});
	test("the allowlisted loopback host:port still opens; a public host opens", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			allowLoopback: ["127.0.0.1:5"],
			resolve: publicDns,
		});
		expect(await b.open(at("http", "127.0.0.1:5/"))).not.toMatch(/failed/);
		expect(site.calls).toContain("tab.open");
		expect(await b.open(at("https", "example.com/"))).not.toMatch(/failed/);
	});
	test("an open step in browser_task is checked too", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			allowLoopback: ["127.0.0.1:5"],
			resolve: publicDns,
		});
		await b.open(at("http", "127.0.0.1:5/"));
		const out = JSON.parse(await b.run([{ action: "open", url: at("http", "169.254.169.254/") }]));
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/Refused/);
		expect(site.calls).not.toContain("nav.go");
	});
	test("a named profile ignores the loopback allowlist", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			allowLoopback: ["127.0.0.1:5"],
			resolve: publicDns,
		});
		expect(await b.open(at("http", "127.0.0.1:5/"))).toMatch(/failed/);
		expect(site.calls).not.toContain("tab.open");
	});
	test("allowLoopback entries that are not loopback are ignored", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			allowLoopback: ["192.168.1.1:80", "169.254.169.254:80"],
			resolve: publicDns,
		});
		expect(await b.open(at("http", "192.168.1.1:80/"))).toMatch(/Refused/);
		expect(await b.open(at("http", "169.254.169.254:80/"))).toMatch(/Refused/);
	});
});

describe("secretsPathInHome: the Windows secrets-file rule, run on any OS (#3814)", () => {
	const home = "C:\\Users\\james";
	test("inside the home folder is accepted, case-insensitively", () => {
		expect(secretsPathInHome("C:\\Users\\james\\.8gent\\secrets.json", home, "win32")).toBe(true);
		expect(secretsPathInHome("c:\\users\\JAMES\\AppData\\Local\\Temp\\s.json", home, "win32")).toBe(
			true,
		);
	});
	test("outside the home folder is refused", () => {
		for (const f of [
			"C:\\ProgramData\\secrets.json",
			"D:\\shared\\secrets.json",
			"C:\\Users\\other\\secrets.json",
			"C:\\Users\\james-old\\secrets.json",
			"C:\\Users\\james\\..\\other\\secrets.json",
			"\\\\server\\share\\secrets.json",
			"C:\\Users\\james",
		])
			expect(secretsPathInHome(f, home, "win32"), f).toBe(false);
	});
	test("posix rules are unchanged by the helper", () => {
		expect(secretsPathInHome("/home/a/s.json", "/home/a", "linux")).toBe(true);
		expect(secretsPathInHome("/tmp/s.json", "/home/a", "linux")).toBe(false);
	});
});

describe("secret placeholders: the model never holds the value (#3604)", () => {
	const SECRET = "s3cr3t-Value-42";
	const OTHER = "other-secret-77";
	const dir = mkdtempSync(join(tmpdir(), "browser-secrets-"));
	const file = join(dir, "secrets.json");
	const write = (mode: number) => {
		writeFileSync(
			file,
			JSON.stringify({
				APP_PW: { value: SECRET, hosts: ["127.0.0.1"] },
				OTHER_PW: { value: OTHER, hosts: ["example.com"] },
				NO_HOSTS: { value: "nohost-secret" },
			}),
		);
		chmodSync(file, mode);
	};
	const mk = (call: BrowserCall, secretsFile: string | undefined = file) =>
		createEightBrowser(call, { settleMs: 0, secretsFile, allowLoopback: ["127.0.0.1:5"] });
	const typeStep = (text: string) => [{ action: "type", selector: "input[name=username]", text }];
	const open = async (b: ReturnType<typeof createEightBrowser>) => b.open("http://127.0.0.1:5/");
	const sent = (calls: Array<{ cmd: string; args: Record<string, unknown> }>) =>
		calls.filter((c) => c.cmd === "page.type").map((c) => c.args.text);

	test("the page receives the real value; no output carries it", async () => {
		write(0o600);
		const site = fakeSite();
		const b = mk(site.call);
		await open(b);
		const out = await b.run(typeStep("{{secret:APP_PW}}"));
		expect(JSON.parse(out).ok).toBe(true);
		expect(sent(site.calls)).toEqual([SECRET]);
		expect(out).not.toContain(SECRET);
		expect(await b.state()).not.toContain(SECRET);
	});

	test("a transport error that echoes the value is scrubbed", async () => {
		write(0o600);
		const site = fakeSite();
		const boom: BrowserCall = async (cmd, args) => {
			if (cmd === "page.type") throw new Error(`transport died typing ${String(args?.text)}`);
			return site.call(cmd, args);
		};
		const b = mk(boom);
		await open(b);
		let msg = "";
		try {
			await b.run(typeStep("{{secret:APP_PW}}"));
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).not.toBe("");
		expect(msg).not.toContain(SECRET);
	});

	test("a page reply that echoes the value is scrubbed from the result", async () => {
		write(0o600);
		const site = fakeSite();
		const echo: BrowserCall = async (cmd, args) =>
			cmd === "page.type"
				? { ok: false, error: `rejected input ${String(args?.text)}` }
				: site.call(cmd, args);
		const b = mk(echo);
		await open(b);
		const out = await b.run(typeStep("{{secret:APP_PW}}"));
		expect(out).not.toContain(SECRET);
	});

	test("refused with nothing typed: wrong host, unknown name, no host list, no file, loose file mode", async () => {
		for (const [label, text, setup] of [
			["wrong host", "{{secret:OTHER_PW}}", () => write(0o600)],
			["unknown name", "{{secret:NOPE}}", () => write(0o600)],
			["no host list", "{{secret:NO_HOSTS}}", () => write(0o600)],
			// Windows has no mode bits to loosen; the check does not apply there.
			...(process.platform === "win32"
				? []
				: ([["loose mode", "{{secret:APP_PW}}", () => write(0o644)]] as const)),
		] as const) {
			setup();
			const site = fakeSite();
			const b = mk(site.call);
			await open(b);
			const out = await b.run(typeStep(text));
			expect(JSON.parse(out).ok, label).toBe(false);
			expect(sent(site.calls), label).toEqual([]);
			for (const v of [SECRET, OTHER, "nohost-secret"]) expect(out, label).not.toContain(v);
		}
		const site = fakeSite();
		const b = mk(site.call, "");
		await open(b);
		expect(JSON.parse(await b.run(typeStep("{{secret:APP_PW}}"))).ok).toBe(false);
		expect(sent(site.calls)).toEqual([]);
	});

	test("a plan with a refused placeholder types nothing, not even earlier steps", async () => {
		write(0o600);
		const site = fakeSite();
		const b = mk(site.call);
		await open(b);
		const out = await b.run([
			{ action: "type", selector: "input[name=username]", text: "alice" },
			{ action: "type", selector: "input[name=username]", text: "{{secret:OTHER_PW}}" },
		]);
		expect(JSON.parse(out).ok).toBe(false);
		expect(sent(site.calls)).toEqual([]);
	});

	test("text without a placeholder is typed as given", async () => {
		write(0o600);
		const site = fakeSite();
		const b = mk(site.call);
		await open(b);
		await b.run(typeStep("alice {{not-a-secret}}"));
		expect(sent(site.calls)).toEqual(["alice {{not-a-secret}}"]);
		rmSync(dir, { recursive: true, force: true });
	});
});

// ── Task-file credentials: {{file:PATH:Field}} (#4280) ─────────────────────

describe("task-file placeholders: a supplied login is typed without the model holding it", () => {
	const PW = "Zq7pilotPassw0rd";
	const OUTSIDE = "outside-secret-91";
	const ws = mkdtempSync(join(tmpdir(), "browser-taskfile-"));
	const outsideDir = mkdtempSync(join(tmpdir(), "browser-taskfile-out-"));
	const task = (address: string, pw = PW) =>
		writeFileSync(
			join(ws, "TASK.txt"),
			`Local dashboard\n\nAddress:  ${address}\nUsername: pilot-abc\nPassword: ${pw}\n`,
		);
	const mk = (call: BrowserCall, workspace: string | null = ws) =>
		createEightBrowser(call, {
			settleMs: 0,
			secretsFile: "",
			allowLoopback: ["127.0.0.1:5"],
			workspace: workspace ?? undefined,
		});
	const typeStep = (text: string) => [{ action: "type", selector: "input[name=username]", text }];
	const sent = (calls: Array<{ cmd: string; args: Record<string, unknown> }>) =>
		calls.filter((c) => c.cmd === "page.type").map((c) => c.args.text);

	test("the page receives the value from the task file; no output carries it", async () => {
		task("http://127.0.0.1:5/");
		const site = fakeSite();
		const b = mk(site.call);
		await b.open("http://127.0.0.1:5/");
		const out = await b.run(typeStep("{{file:TASK.txt:Password}}"));
		expect(JSON.parse(out).ok).toBe(true);
		expect(sent(site.calls)).toEqual([PW]);
		expect(out).not.toContain(PW);
		expect(await b.state()).not.toContain(PW);
	});

	test("works with no secrets file configured (the default local profile has none)", () => {
		task("http://127.0.0.1:5/");
		const r = resolveSecretText("{{file:TASK.txt:Password}}", "http://127.0.0.1:5/login", "", ws);
		expect(r.ok && r.text).toBe(PW);
		const user = resolveSecretText(
			"{{file:TASK.txt:username}}",
			"http://127.0.0.1:5/",
			undefined,
			ws,
		);
		expect(user.ok && user.text).toBe("pilot-abc");
	});

	test("a transport error that echoes the file value is scrubbed", async () => {
		task("http://127.0.0.1:5/");
		const site = fakeSite();
		const boom: BrowserCall = async (cmd, args) => {
			if (cmd === "page.type") throw new Error(`transport died typing ${String(args?.text)}`);
			return site.call(cmd, args);
		};
		const b = mk(boom);
		await b.open("http://127.0.0.1:5/");
		let msg = "";
		try {
			await b.run(typeStep("{{file:TASK.txt:Password}}"));
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).not.toBe("");
		expect(msg).not.toContain(PW);
	});

	test("a page reply that echoes the value is scrubbed from the result", async () => {
		task("http://127.0.0.1:5/");
		const site = fakeSite();
		const echo: BrowserCall = async (cmd, args) =>
			cmd === "page.type"
				? { ok: false, error: `rejected input ${String(args?.text)}` }
				: site.call(cmd, args);
		const b = mk(echo);
		await b.open("http://127.0.0.1:5/");
		expect(await b.run(typeStep("{{file:TASK.txt:Password}}"))).not.toContain(PW);
	});

	test("refused with nothing typed: address not in the file, missing field, missing file, no workspace", async () => {
		for (const [label, text, address, workspace] of [
			["other port in file", "{{file:TASK.txt:Password}}", "http://127.0.0.1:6/", ws],
			["missing field", "{{file:TASK.txt:Token}}", "http://127.0.0.1:5/", ws],
			["missing file", "{{file:NOPE.txt:Password}}", "http://127.0.0.1:5/", ws],
			["no workspace", "{{file:TASK.txt:Password}}", "http://127.0.0.1:5/", null],
		] as const) {
			task(address);
			const site = fakeSite();
			const b = mk(site.call, workspace);
			await b.open("http://127.0.0.1:5/");
			const out = await b.run(typeStep(text));
			expect(JSON.parse(out).ok, label).toBe(false);
			expect(sent(site.calls), label).toEqual([]);
			expect(out, label).not.toContain(PW);
		}
	});

	test("never typed on a non-loopback page, even when the file names that address", () => {
		task("https://app.example.com/");
		const r = resolveTaskFileField(ws, "TASK.txt", "Password", "https://app.example.com/login");
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(PW);
	});

	test("path rules: no dot segments, no absolute paths, no escape through a symlink", () => {
		task("http://127.0.0.1:5/");
		writeFileSync(join(outsideDir, "creds.txt"), `Password: ${OUTSIDE}\nhttp://127.0.0.1:5/\n`);
		writeFileSync(join(ws, ".env"), `Password: ${OUTSIDE}\nhttp://127.0.0.1:5/\n`);
		mkdirSync(join(ws, "sub"), { recursive: true });
		if (process.platform !== "win32")
			symlinkSync(join(outsideDir, "creds.txt"), join(ws, "sub", "link.txt"));
		const page = "http://127.0.0.1:5/";
		for (const rel of [
			".env",
			"../TASK.txt",
			"sub/../TASK.txt",
			join(outsideDir, "creds.txt"),
			...(process.platform !== "win32" ? ["sub/link.txt"] : []),
		]) {
			const r = resolveTaskFileField(ws, rel, "Password", page);
			expect(r.ok, rel).toBe(false);
			expect(JSON.stringify(r), rel).not.toContain(OUTSIDE);
		}
		expect(resolveTaskFileField(ws, "TASK.txt", "Password", page).ok).toBe(true);
	});

	test("a symlink with a plain name is refused when its target is a dot file", () => {
		if (process.platform === "win32") return;
		writeFileSync(join(ws, ".secrets.yml"), `Password: ${OUTSIDE}\nhttp://127.0.0.1:5/\n`);
		symlinkSync(join(ws, ".secrets.yml"), join(ws, "innocent.txt"));
		const r = resolveTaskFileField(ws, "innocent.txt", "Password", "http://127.0.0.1:5/");
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(OUTSIDE);
	});

	test("a FIFO named like a task file is refused fast instead of hanging", () => {
		if (process.platform === "win32") return;
		const made = Bun.spawnSync(["mkfifo", join(ws, "pipe.txt")]);
		expect(made.exitCode).toBe(0);
		const t0 = Date.now();
		const r = resolveTaskFileField(ws, "pipe.txt", "Password", "http://127.0.0.1:5/");
		expect(r.ok).toBe(false);
		expect(Date.now() - t0).toBeLessThan(2000);
	});

	test("a file over the size cap is refused", () => {
		writeFileSync(
			join(ws, "big.txt"),
			`Password: ${PW}\nhttp://127.0.0.1:5/\n${"x".repeat(70_000)}`,
		);
		expect(resolveTaskFileField(ws, "big.txt", "Password", "http://127.0.0.1:5/").ok).toBe(false);
	});

	test("a hard link to a file outside the workspace is refused", () => {
		writeFileSync(join(outsideDir, "hard.txt"), `Password: ${OUTSIDE}\nhttp://127.0.0.1:5/\n`);
		linkSync(join(outsideDir, "hard.txt"), join(ws, "hard.txt"));
		const r = resolveTaskFileField(ws, "hard.txt", "Password", "http://127.0.0.1:5/");
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(OUTSIDE);
	});

	test("a parent folder swapped for a symlink between check and open is refused", () => {
		if (process.platform === "win32") return;
		mkdirSync(join(ws, "d"), { recursive: true });
		writeFileSync(join(ws, "d", "T.txt"), "Password: inside-ok\nhttp://127.0.0.1:5/\n");
		mkdirSync(join(outsideDir, "d"), { recursive: true });
		writeFileSync(join(outsideDir, "d", "T.txt"), `Password: ${OUTSIDE}\nhttp://127.0.0.1:5/\n`);
		const realOpen = fsModule.openSync;
		const spy = spyOn(fsModule, "openSync").mockImplementation(((
			...a: Parameters<typeof realOpen>
		) => {
			if (String(a[0]).endsWith(join("d", "T.txt"))) {
				renameSync(join(ws, "d"), join(ws, "d-moved"));
				symlinkSync(join(outsideDir, "d"), join(ws, "d"));
			}
			return realOpen(...a);
		}) as typeof realOpen);
		try {
			const r = resolveTaskFileField(ws, "d/T.txt", "Password", "http://127.0.0.1:5/");
			expect(spy).toHaveBeenCalled();
			expect(r.ok).toBe(false);
			expect(JSON.stringify(r)).not.toContain(OUTSIDE);
		} finally {
			spy.mockRestore();
		}
	});

	test("a value holding a control character is refused", () => {
		writeFileSync(join(ws, "TAB.txt"), "Password: abc\tdef\nhttp://127.0.0.1:5/\n");
		const r = resolveTaskFileField(ws, "TAB.txt", "Password", "http://127.0.0.1:5/");
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain("def");
	});

	// #4417: the login recipe copies the password line into .tmp/login as password=...
	test("a password=... line in .tmp/login fills the field and the error path never carries the value", async () => {
		task("http://127.0.0.1:5/", "unused-in-task");
		mkdirSync(join(ws, ".tmp"), { recursive: true });
		writeFileSync(join(ws, ".tmp", "login"), `password=${PW}\n`);
		const site = fakeSite();
		const b = mk(site.call);
		await b.open("http://127.0.0.1:5/");
		const out = await b.run(typeStep("{{file:.tmp/login:password}}"));
		expect(JSON.parse(out).ok).toBe(true);
		expect(sent(site.calls)).toContain(PW);
		expect(out).not.toContain(PW);
	});

	test("a wrong-format file fails with one plain sentence naming the format, not a redaction marker", () => {
		mkdirSync(join(ws, ".tmp"), { recursive: true });
		writeFileSync(join(ws, ".tmp", "bad"), `pw ${PW}\nhttp://127.0.0.1:5/\n`);
		const r = resolveTaskFileField(ws, ".tmp/bad", "password", "http://127.0.0.1:5/");
		expect(r.ok).toBe(false);
		const msg = JSON.stringify(r);
		expect(msg).toContain("Expected a line `Field: value` or `Field=value`");
		expect(msg).not.toContain(PW);
		expect(scrubSecrets(msg).redactedCount).toBe(0);
	});

	test("other dot folders stay refused; only .tmp is allowed", () => {
		mkdirSync(join(ws, ".git"), { recursive: true });
		writeFileSync(join(ws, ".git", "login"), `password=${OUTSIDE}\nhttp://127.0.0.1:5/\n`);
		const r = resolveTaskFileField(ws, ".git/login", "password", "http://127.0.0.1:5/");
		expect(r.ok).toBe(false);
		expect(JSON.stringify(r)).not.toContain(OUTSIDE);
	});

	test("a resolved value is never read again as a placeholder", () => {
		task("http://127.0.0.1:5/", "{{secret:APP_PW}}");
		const r = resolveSecretText("{{file:TASK.txt:Password}}", "http://127.0.0.1:5/", "", ws);
		expect(r.ok && r.text).toBe("{{secret:APP_PW}}");
		rmSync(ws, { recursive: true, force: true });
		rmSync(outsideDir, { recursive: true, force: true });
	});
});

// ── Local sessions get the browser by default (#3785) ───────────────────────

describe("default local profile: a local session's own isolated browser (#3785)", () => {
	const HOME = "/Users/someone";
	beforeEach(() => setDefaultLocalProfile(LOCAL_BROWSER_PROFILE));
	afterEach(() => setDefaultLocalProfile(null));

	test("with EIGHT_BROWSER_PROFILE unset the default applies: a named profile under ~/.8gent/browser-profiles", () => {
		const p = browserProfile({}, HOME);
		expect(p?.name).toBe("eight-local");
		expect(p?.tokenFile).toBe(
			join(HOME, ".8gent", "browser-profiles", "eight-local", "browser-control.token"),
		);
		expect(p?.tokenFile).not.toBe(join(HOME, ".8gent", "browser-control.token"));
		expect(usingDefaultLocalProfile({})).toBe(true);
		expect(localBrowserTools({})).toEqual([
			"browser_open",
			"browser_state",
			"browser_task",
			"browser_screenshot",
		]);
		expect(browserWithheldNote({})).toBeNull();
	});
	test("an explicit profile wins over the default; an explicit 'default' still means no isolated browser", () => {
		expect(browserProfile({ EIGHT_BROWSER_PROFILE: "eightgent" }, HOME)?.name).toBe("eightgent");
		expect(usingDefaultLocalProfile({ EIGHT_BROWSER_PROFILE: "eightgent" })).toBe(false);
		expect(browserProfile({ EIGHT_BROWSER_PROFILE: "default" }, HOME)).toBeNull();
		expect(localBrowserTools({ EIGHT_BROWSER_PROFILE: "default" })).toEqual([]);
		expect(() => browserProfile({ EIGHT_BROWSER_PROFILE: "../x" }, HOME)).toThrow(
			/EIGHT_BROWSER_PROFILE/,
		);
	});
	test("EIGHT_BROWSER_LOCAL=0 opts out: no browser tools, and the note says why", () => {
		const env = { EIGHT_BROWSER_LOCAL: "0" };
		expect(browserProfile(env, HOME)).toBeNull();
		expect(localBrowserTools(env)).toEqual([]);
		expect(usingDefaultLocalProfile(env)).toBe(false);
		const note = browserWithheldNote(env) ?? "";
		expect(note).toMatch(/EIGHT_BROWSER_LOCAL=0/);
		expect(note).toContain("local-server curl rules");
		expect(note).not.toContain("\u2014");
	});
	test("the browser-use backend never gets the default profile", () => {
		expect(browserProfile({ EIGHT_BROWSER_BACKEND: "browser-use" }, HOME)).toBeNull();
		expect(localBrowserTools({ EIGHT_BROWSER_BACKEND: "browser-use" })).toEqual([]);
	});
	test("the default is validated like any name: never the default profile, never a path", () => {
		for (const bad of ["default", "../x", "Eight", ""])
			expect(() => setDefaultLocalProfile(bad)).toThrow(/slug/);
		setDefaultLocalProfile(null);
		expect(browserProfile({}, HOME)).toBeNull();
		expect(localBrowserTools({})).toEqual([]);
		expect(browserWithheldNote({})).toMatch(/not offered/);
	});
	test("the default local profile never reads a secrets file for {{secret:NAME}}", async () => {
		const dir = mkdtempSync(join(tmpdir(), "8b-local-secrets-"));
		const file = join(dir, "secrets.json");
		writeFileSync(file, JSON.stringify({ PW: { value: "hunter2", hosts: ["example.com"] } }));
		chmodSync(file, 0o600);
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			secretsFile: file,
			env: {},
		});
		await b.open("https://example.com/");
		const out = JSON.parse(
			await b.run([{ action: "type", selector: "input[name=q]", text: "{{secret:PW}}" }]),
		);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/no secrets file is configured/);
		expect(site.calls).not.toContain("page.type");
		rmSync(dir, { recursive: true, force: true });
	});
});

describeNotWin(
	"start on demand: a profile with no port file is launched once, with a minimal env (#3785)",
	() => {
		// These tests run on sandboxed hosts too; the pre-flight has its own tests below.
		beforeEach(() => _setHostSandboxedForTest(false));
		afterEach(() => {
			_setHostSandboxedForTest(null);
			_setProfileHomeForTest(null);
			_setSpawnForTest(() => ({ exited: Promise.resolve("test spawn refused") }));
			_resetLoopbackAllowlistForTest();
		});

		/** A fake 8gent Browser: publishes the token and the fake server's port, then "runs" until stopped. */
		function fakeApp(serverPort: number, token: string) {
			const specs: BrowserLaunchSpec[] = [];
			let stop: (reason: string) => void = () => {};
			_setSpawnForTest((spec) => {
				specs.push(spec);
				mkdirSync(join(spec.portFile, ".."), { recursive: true });
				writeFileSync(spec.tokenFile, `${token}\n`);
				writeFileSync(spec.portFile, String(serverPort));
				return { exited: new Promise<string>((r) => (stop = r)) };
			});
			return { specs, stop: (why: string) => stop(why) };
		}

		test("the launched profile is used: the transport connects to the port it published", async () => {
			const { server, tokens } = serveCall(nextSite().call, "fresh-tok");
			const workspace = mkdtempSync(join(tmpdir(), "8b-ws-"));
			mkdirSync(join(workspace, ".8gent"));
			writeFileSync(
				join(workspace, ".8gent", "allow-loopback.json"),
				JSON.stringify({ allow: ["127.0.0.1:5173", "localhost:7980"] }),
			);
			const app = fakeApp(Number(server.port), "fresh-tok");
			try {
				const home = mkdtempSync(join(tmpdir(), "8b-launch-home-"));
				// The trusted user-level list (8SO): ~/.8gent/allow-loopback.json. The workspace file above is ignored.
				mkdirSync(join(home, ".8gent"), { recursive: true });
				writeFileSync(
					join(home, ".8gent", "allow-loopback.json"),
					JSON.stringify({ allow: ["127.0.0.1:5174", "localhost:7980"] }),
				);
				_setProfileHomeForTest(home);
				const env = {
					EIGHT_BROWSER_PROFILE: "eightgent",
					EIGHT_BROWSER_APP: "/fake/8gent Browser",
					EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:3000",
					OPENROUTER_API_KEY: "sk-never",
					ANTHROPIC_API_KEY: "sk-never",
					PATH: "/usr/bin:/bin",
					HOME: "/not/the/profile/home",
				};
				const call = wsTransport({ env });
				expect(await call("tab.open", { url: "https://example.com/" })).toEqual({ id: "t9" });
				await call("tab.open", { url: "https://example.com/" });
				expect(tokens).toEqual(["fresh-tok", "fresh-tok"]);
				expect(app.specs.length).toBe(1); // one launch per profile per process
				const spec = app.specs[0];
				expect(spec.bin).toBe("/fake/8gent Browser");
				expect(spec.profile).toBe("eightgent");
				expect(Object.keys(spec.env).sort()).toEqual(
					[
						"EIGHT_BROWSER_ALLOW_LOOPBACK",
						"EIGHT_BROWSER_CONTROL_PORT",
						"EIGHT_BROWSER_PROFILE",
						"HOME",
						"PATH",
					].sort(),
				);
				expect(spec.env.HOME).not.toBe("/not/the/profile/home"); // the home the port file is read from
				expect(spec.env.EIGHT_BROWSER_PROFILE).toBe("eightgent");
				expect(Number(spec.env.EIGHT_BROWSER_CONTROL_PORT)).toBe(spec.port);
				expect(spec.port).not.toBe(7980);
				expect([...RESERVED_LOOPBACK_PORTS]).not.toContain(spec.port);
				// Trusted sources only: env list plus ~/.8gent/allow-loopback.json; the workspace file's 5173
				// is ignored and the reserved 7980 entry dropped.
				expect(spec.env.EIGHT_BROWSER_ALLOW_LOOPBACK.split(",").sort()).toEqual([
					"127.0.0.1:3000",
					"127.0.0.1:5174",
				]);
				expect(JSON.stringify(spec.env)).not.toMatch(/sk-never|OPENROUTER|ANTHROPIC/);
			} finally {
				app.stop("stopped");
				server.stop(true);
				rmSync(workspace, { recursive: true, force: true });
			}
		});

		test("a child that exits at once fails fast with the reason and the curl alternative; not retried", async () => {
			let spawns = 0;
			_setSpawnForTest(() => {
				spawns++;
				return { exited: Promise.resolve("exited with code 1") };
			});
			_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
			const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
			const t0 = Date.now();
			const call = wsTransport({ env });
			await expect(call("tabs.list")).rejects.toThrow(
				"8gent Browser could not start (exited with code 1). For a local web app use run_command with curl instead.",
			);
			await expect(call("tabs.list")).rejects.toThrow(/could not start/);
			expect(Date.now() - t0).toBeLessThan(5_000);
			expect(spawns).toBe(1);
		});

		test("under a host sandbox nothing is spawned: one clear error, no crash report (#4099)", async () => {
			let spawns = 0;
			_setSpawnForTest(() => {
				spawns++;
				return { exited: Promise.resolve("exited with SIGTRAP") };
			});
			_setHostSandboxedForTest(true);
			_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
			const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
			const call = wsTransport({ env });
			let message = "";
			await call("tabs.list").catch((e: Error) => (message = e.message));
			expect(message).toMatch(
				/^8gent Browser could not start \(this process runs inside a macOS sandbox, where 8gent Browser cannot register its Mach port with launchd; start the profile from outside the sandbox .*\)\.$/,
			);
			expect(message).not.toMatch(/curl/); // no curl sign-in detour for a sandboxed host (Karen, #4100)
			await expect(call("tabs.list")).rejects.toThrow(/inside a macOS sandbox/);
			expect(spawns).toBe(0);
		});

		test("a child that crashes leaves its last stderr line in the reason and a launch log by the port file (#4099)", async () => {
			const home = mkdtempSync(join(tmpdir(), "8b-launch-home-"));
			const app = join(home, "fake-browser.sh");
			// Stands in for 8gent Browser trapping under a seatbelt: Chromium's FATAL line, then SIGTRAP.
			writeFileSync(
				app,
				[
					"#!/bin/sh",
					'echo "[4242:1012/183428.614481:FATAL:base/apple/mach_port_rendezvous_mac.cc(159)] Check failed: kr == KERN_SUCCESS. bootstrap_check_in test: Permission denied (1100)" >&2',
					"kill -TRAP $$",
				].join("\n"),
			);
			chmodSync(app, 0o755);
			_setSpawnForTest(null); // the real spawner, on a shell script, never the app
			_setProfileHomeForTest(home);
			const env = {
				EIGHT_BROWSER_PROFILE: "eightgent",
				EIGHT_BROWSER_APP: app,
				PATH: process.env.PATH,
			};
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
				/could not start \(exited with SIGTRAP: FATAL:base\/apple\/mach_port_rendezvous_mac\.cc\(159\)\] Check failed: kr == KERN_SUCCESS\. bootstrap_check_in test: Permission denied \(1100\)\)/,
			);
			const log = join(home, ".8gent", "browser-profiles", "eightgent", "browser-launch.log");
			expect(readFileSync(log, "utf8")).toContain("Permission denied (1100)");
			// Made before the browser runs, so no looser than the browser makes them: dir 0o700, log 0o600.
			expect(statSync(join(log, "..")).mode & 0o777).toBe(0o700);
			expect(statSync(log).mode & 0o777).toBe(0o600);
			rmSync(home, { recursive: true, force: true });
		});

		test("launchLogTail prefers the FATAL line, strips the pid prefix and caps the length", () => {
			const dir = mkdtempSync(join(tmpdir(), "8b-log-"));
			const f = join(dir, "browser-launch.log");
			expect(launchLogTail(f)).toBeNull();
			writeFileSync(f, "");
			expect(launchLogTail(f)).toBeNull();
			writeFileSync(
				f,
				"[1:0101/000000.000000:WARNING:a.cc(1)] first\n[1:0101/000000.000001:FATAL:b.cc(2)] Check failed: x\nlast plain line\n",
			);
			expect(launchLogTail(f)).toBe("FATAL:b.cc(2)] Check failed: x");
			writeFileSync(f, `${"y".repeat(500)}\n`);
			expect(launchLogTail(f)?.length).toBe(240);
			rmSync(dir, { recursive: true, force: true });
		});

		test("no app to launch is a short error too, and names the setting", async () => {
			const spawned: BrowserLaunchSpec[] = [];
			_setSpawnForTest((spec) => {
				spawned.push(spec);
				return { exited: Promise.resolve("never") };
			});
			_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
			const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "" };
			if (process.platform === "darwin") return; // the real app may be installed here; the fake above covers the rest
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
				/could not start \(no 8gent Browser app found; set EIGHT_BROWSER_APP/,
			);
			expect(spawned).toEqual([]);
		});
	},
);

describeNotWin("a launch that cannot run the profile never stays running (#4103)", () => {
	beforeEach(() => _setHostSandboxedForTest(false));
	afterEach(() => {
		_setHostSandboxedForTest(null);
		_setProfileHomeForTest(null);
		_setLaunchWaitForTest(null);
		_setSpawnForTest(() => ({ exited: Promise.resolve("test spawn refused") }));
	});

	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};

	/** A real child that never publishes a port, started the way realSpawn starts the browser. */
	function sleeper(script: string, onSpawn?: () => void) {
		const pids: number[] = [];
		_setSpawnForTest(() => {
			onSpawn?.();
			const child = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" });
			if (child.pid) pids.push(child.pid);
			const exited = new Promise<string>((r) =>
				child.once("exit", (code, sig) => r(`exited with ${sig ?? `code ${code}`}`)),
			);
			child.unref();
			return { exited, pid: child.pid, detached: true };
		});
		return pids;
	}

	/** A fake macOS app bundle with the given version and app.asar content. */
	function fakeBundle(version: string | null, asar: string | null): string {
		const root = mkdtempSync(join(tmpdir(), "8b-bundle-"));
		const contents = join(root, "8gent Browser.app", "Contents");
		mkdirSync(join(contents, "MacOS"), { recursive: true });
		mkdirSync(join(contents, "Resources"), { recursive: true });
		const bin = join(contents, "MacOS", "8gent Browser");
		writeFileSync(bin, "#!/bin/sh\nexit 0\n");
		chmodSync(bin, 0o755);
		if (version !== null)
			writeFileSync(
				join(contents, "Info.plist"),
				`<?xml version="1.0"?><plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>`,
			);
		if (asar !== null) writeFileSync(join(contents, "Resources", "app.asar"), asar);
		return bin;
	}

	test("timeout: the child is stopped and the error says so (curl hint kept)", async () => {
		const pids = sleeper("exec sleep 60");
		_setLaunchWaitForTest(300);
		_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
		const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
		await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
			'8gent Browser could not start (profile "eightgent" published no port within 0.3 s; stopped the browser it started). For a local web app use run_command with curl instead.',
		);
		expect(pids.length).toBe(1);
		expect(alive(pids[0])).toBe(false);
	});

	test("timeout: a child that ignores SIGTERM is killed, with its process group", async () => {
		// The shell and its sleeps all ignore TERM (inherited), as a wedged browser and a helper would.
		// The background sleep outlives a kill of the leader alone, so only a group SIGKILL ends it.
		const pids = sleeper("trap '' TERM; sleep 60 & while :; do sleep 0.1; done");
		_setLaunchWaitForTest(300);
		_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
		const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
		await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
			/published no port within 0\.3 s; killed the browser it started \(SIGTERM was ignored\)/,
		);
		expect(alive(pids[0])).toBe(false);
		// The group's other member (the loop's sleep) is orphaned when the leader dies, and is only gone
		// once its new parent reaps it: init, or tini under the Linux gate's `docker run --init`. Until
		// then kill(-pgid, 0) still finds it as a zombie. The CI log for #4104 showed exactly that
		// race, so wait (bounded) for the reap, and still fail if anything in the group survives.
		const groupAlive = () => {
			try {
				process.kill(-pids[0], 0);
				return true;
			} catch {
				return false;
			}
		};
		const until = Date.now() + 3_000;
		while (groupAlive() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
		expect(groupAlive()).toBe(false);
	}, 10_000);

	test("a group already gone (ESRCH) never gets a bare-pid signal, which could hit a reused pid (8SO)", async () => {
		const calls: [number, string][] = [];
		_setKillForTest((pid, sig) => {
			calls.push([pid, sig]);
			const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
			e.code = "ESRCH";
			throw e;
		});
		try {
			_setSpawnForTest(() => ({
				exited: new Promise<string>(() => {}),
				pid: 424242,
				detached: true,
			}));
			_setLaunchWaitForTest(100);
			_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
			const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(/published no port/);
			expect(calls).toEqual([
				[-424242, "SIGTERM"],
				[-424242, "SIGKILL"],
			]);
		} finally {
			_setKillForTest(null);
		}
	}, 10_000);

	test("EPERM on the group falls back to the pid itself", async () => {
		const calls: [number, string][] = [];
		_setKillForTest((pid, sig) => {
			calls.push([pid, sig]);
			if (pid < 0) {
				const e = new Error("kill EPERM") as NodeJS.ErrnoException;
				e.code = "EPERM";
				throw e;
			}
		});
		try {
			_setSpawnForTest(() => ({
				exited: new Promise<string>(() => {}),
				pid: 424243,
				detached: true,
			}));
			_setLaunchWaitForTest(100);
			_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
			const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
			await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(/published no port/);
			expect(calls).toEqual([
				[-424243, "SIGTERM"],
				[424243, "SIGTERM"],
				[-424243, "SIGKILL"],
				[424243, "SIGKILL"],
			]);
		} finally {
			_setKillForTest(null);
		}
	}, 10_000);

	test("a child that writes the default token instead of the profile's is stopped at once, no curl hint", async () => {
		const home = mkdtempSync(join(tmpdir(), "8b-launch-home-"));
		// Stands in for desktop-v0.3.0: EIGHT_BROWSER_PROFILE ignored, the DEFAULT token written under HOME.
		const pids = sleeper(
			`mkdir -p '${home}/.8gent' && echo tok > '${home}/.8gent/browser-control.token' && exec sleep 60`,
		);
		_setProfileHomeForTest(home); // the full 20 s wait: this must not need it
		const env = { EIGHT_BROWSER_PROFILE: "eightgent", EIGHT_BROWSER_APP: "/fake/8gent Browser" };
		const t0 = Date.now();
		let message = "";
		await wsTransport({ env })("tabs.list").catch((e: Error) => (message = e.message));
		expect(message).toBe(
			"8gent Browser could not start (the 8gent Browser it started does not support named profiles: it wrote the default profile's token, not the profile's own; stopped the browser it started. Update it or set EIGHT_BROWSER_APP to a newer build).",
		);
		expect(Date.now() - t0).toBeLessThan(5_000);
		expect(alive(pids[0])).toBe(false);
	});

	test("a pre-profile build (0.3.0, no marker in app.asar) is refused without spawning, naming both versions", async () => {
		let spawns = 0;
		_setSpawnForTest(() => {
			spawns++;
			return { exited: Promise.resolve("never") };
		});
		_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
		const bin = fakeBundle("0.3.0", "main bundle without profile support");
		const env = { EIGHT_BROWSER_PROFILE: "eight-local", EIGHT_BROWSER_APP: bin };
		let message = "";
		await wsTransport({ env })("tabs.list").catch((e: Error) => (message = e.message));
		expect(message).toBe(
			`8gent Browser could not start (the installed 8gent Browser 0.3.0 does not support named profiles; it needs ${PROFILE_MIN_VERSION} or later. Update it or set EIGHT_BROWSER_APP to a newer build).`,
		);
		expect(message).not.toMatch(/curl/);
		expect(spawns).toBe(0);
	});

	test("an older version with no app.asar is refused too; one at the minimum, or a 0.3.0 build carrying the marker, is launched", async () => {
		const spawned: string[] = [];
		_setSpawnForTest((spec) => {
			spawned.push(spec.bin);
			return { exited: Promise.resolve("exited with code 1") };
		});
		const run = async (bin: string, profile: string) => {
			_setProfileHomeForTest(mkdtempSync(join(tmpdir(), "8b-launch-home-")));
			let message = "";
			await wsTransport({ env: { EIGHT_BROWSER_PROFILE: profile, EIGHT_BROWSER_APP: bin } })(
				"tabs.list",
			).catch((e: Error) => (message = e.message));
			return message;
		};
		expect(await run(fakeBundle("0.2.0", null), "pa")).toMatch(
			/8gent Browser 0\.2\.0 does not support named profiles/,
		);
		expect(spawned).toEqual([]);
		const atMin = fakeBundle(PROFILE_MIN_VERSION, null);
		expect(await run(atMin, "pb")).toMatch(/exited with code 1/);
		const devBuild = fakeBundle("0.3.0", "...const raw = env.EIGHT_BROWSER_PROFILE...");
		expect(await run(devBuild, "pc")).toMatch(/exited with code 1/);
		expect(spawned).toEqual([atMin, devBuild]);
	});

	test("compareVersions", () => {
		expect(compareVersions("0.3.0", "0.3.1")).toBeLessThan(0);
		expect(compareVersions("0.4.0", "0.3.1")).toBeGreaterThan(0);
		expect(compareVersions("0.3.1", "0.3.1")).toBe(0);
		expect(compareVersions("1.0", "0.9.9")).toBeGreaterThan(0);
	});
});

describe("browserBinary picks a build that can run a named profile (#3589)", () => {
	afterEach(() => _setAppDirsForTest(null));

	/** <dir>/8gent Browser.app with the given version and app.asar content; returns the binary path. */
	function bundleIn(dir: string, version: string, asar: string): string {
		const contents = join(dir, "8gent Browser.app", "Contents");
		mkdirSync(join(contents, "MacOS"), { recursive: true });
		mkdirSync(join(contents, "Resources"), { recursive: true });
		const bin = join(contents, "MacOS", "8gent Browser");
		writeFileSync(bin, "#!/bin/sh\nexit 0\n");
		chmodSync(bin, 0o755);
		writeFileSync(
			join(contents, "Info.plist"),
			`<?xml version="1.0"?><plist version="1.0"><dict>\n<key>CFBundleShortVersionString</key>\n<string>${version}</string>\n</dict></plist>`,
		);
		writeFileSync(join(contents, "Resources", "app.asar"), asar);
		return bin;
	}
	const dirs = () => {
		const root = mkdtempSync(join(tmpdir(), "8b-appdirs-"));
		const d = ["system", "user", "own"].map((n) => join(root, n));
		for (const x of d) mkdirSync(x, { recursive: true });
		_setAppDirsForTest(d);
		return d;
	};

	test.skipIf(process.platform !== "darwin")(
		"an old build first in the list loses to a later one that supports profiles (James's /Applications 0.3.0 vs ~/.8gent/apps)",
		() => {
			const [system, , own] = dirs();
			bundleIn(system, "0.3.0", "no marker here");
			const good = bundleIn(own, "0.3.0", "...env.EIGHT_BROWSER_PROFILE...");
			expect(browserBinary({}, "/nowhere")).toBe(good);
		},
	);

	test.skipIf(process.platform !== "darwin")("the first capable build wins; order is kept", () => {
		const [system, user, own] = dirs();
		const first = bundleIn(system, PROFILE_MIN_VERSION, "x");
		bundleIn(user, PROFILE_MIN_VERSION, "x");
		bundleIn(own, PROFILE_MIN_VERSION, "x");
		expect(browserBinary({}, "/nowhere")).toBe(first);
	});

	test.skipIf(process.platform !== "darwin")(
		"with no capable build the first one found is returned, so the update error still names it",
		() => {
			const [system, user] = dirs();
			const old = bundleIn(system, "0.3.0", "no marker");
			bundleIn(user, "0.2.0", "no marker");
			expect(browserBinary({}, "/nowhere")).toBe(old);
		},
	);

	test.skipIf(process.platform !== "darwin")(
		"EIGHT_BROWSER_APP still wins over every directory",
		() => {
			const [system] = dirs();
			bundleIn(system, PROFILE_MIN_VERSION, "x");
			expect(browserBinary({ EIGHT_BROWSER_APP: "/pinned/8gent Browser" }, "/nowhere")).toBe(
				"/pinned/8gent Browser",
			);
		},
	);

	test.skipIf(process.platform !== "darwin")("no build anywhere is null", () => {
		dirs();
		expect(browserBinary({}, "/nowhere")).toBeNull();
	});

	test.skipIf(process.platform !== "darwin")(
		"default directories: /Applications, ~/Applications, then ~/.8gent/apps under the given home",
		() => {
			const home = mkdtempSync(join(tmpdir(), "8b-home-"));
			const own = join(home, ".8gent", "apps");
			mkdirSync(own, { recursive: true });
			const good = bundleIn(own, "0.3.0", "...EIGHT_BROWSER_PROFILE...");
			const picked = browserBinary({}, home);
			// A capable build in the real /Applications or ~/Applications would come first; this machine's
			// may be the old 0.3.0, so either a real capable one or ours, never an incapable one.
			expect(picked).not.toBeNull();
			if (!picked?.startsWith("/Applications/")) expect(picked).toBe(good);
		},
	);
});

describe("the trusted port list is frozen at session start (8SO)", () => {
	afterEach(() => {
		setDefaultLocalProfile(null);
		_setProfileHomeForTest(null);
		_resetLoopbackAllowlistForTest();
	});
	test("a ~/.8gent/allow-loopback.json written after setDefaultLocalProfile and before the first browser_open changes nothing", async () => {
		const home = mkdtempSync(join(tmpdir(), "8b-freeze-home-"));
		try {
			_setProfileHomeForTest(home);
			_resetLoopbackAllowlistForTest();
			setDefaultLocalProfile(LOCAL_BROWSER_PROFILE); // session start
			mkdirSync(join(home, ".8gent"), { recursive: true });
			writeFileSync(
				join(home, ".8gent", "allow-loopback.json"),
				JSON.stringify({ allow: ["127.0.0.1:5173"] }),
			);
			const site = fakeSite();
			const b = createEightBrowser(site.call, { settleMs: 0, isolated: true, env: process.env });
			expect(await b.open("http://127.0.0.1:5173/")).toMatch(/failed|Refused/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("isolated profile: loopback only on the run's own listed ports (#3785)", () => {
	afterEach(() => _resetLoopbackAllowlistForTest());
	const at = (scheme: string, rest: string) => `${scheme}:/` + `/${rest}`;
	const publicDns = async () => [{ address: "93.184.216.34", family: 4 as const }];
	const workspace = () => mkdtempSync(join(tmpdir(), "8b-loopback-ws-"));

	test("with no list, 127.0.0.1:5173 is refused like any private host", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			workspace: workspace(),
			env: {},
			resolve: publicDns,
		});
		expect(await b.open(at("http", "127.0.0.1:5173/"))).toMatch(/browser_open failed: .*private/);
		expect(site.calls).not.toContain("tab.open");
	});
	test("EIGHT_BROWSER_ALLOW_LOOPBACK=127.0.0.1:5173 opens that port and nothing else", async () => {
		const env = { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:5173,127.0.0.1:7980" };
		const inner = nextSite();
		const call: BrowserCall = async (cmd, args) => {
			if (cmd !== "nav.go") return inner.call(cmd, args);
			inner.calls.push(cmd);
			return { navigating: args?.url };
		};
		const site = { calls: inner.calls, call };
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			workspace: workspace(),
			env,
			resolve: publicDns,
		});
		expect(await b.open(at("http", "127.0.0.1:5173/"))).not.toMatch(/failed/);
		expect(await b.open(at("http", "localhost:5173/app"))).not.toMatch(/failed/);
		expect(site.calls.filter((c) => c === "tab.open").length).toBe(2);
		for (const u of [
			at("http", "127.0.0.1:5174/"),
			at("http", "127.0.0.1:7980/"),
			at("http", "127.0.0.1/"),
			at("http", "10.0.0.1:5173/"),
			at("http", "169.254.169.254/latest/meta-data/"),
			at("http", "user:pw@127.0.0.1:5173/"),
		]) {
			expect(await b.open(u)).toMatch(/browser_open failed/);
		}
		expect(site.calls.filter((c) => c === "tab.open").length).toBe(2);
		// An open step inside browser_task follows the same rule.
		const out = JSON.parse(await b.run([{ action: "open", url: at("http", "127.0.0.1:5174/") }]));
		expect(out.ok).toBe(false);
		expect(site.calls).not.toContain("nav.go");
		const ok = JSON.parse(
			await b.run([{ action: "open", url: at("http", "127.0.0.1:5173/next") }]),
		);
		expect(ok.ok).toBe(true);
	});
	test("a workspace allow-loopback.json is ignored, and the refusal says so (8SO)", async () => {
		const ws = workspace();
		mkdirSync(join(ws, ".8gent"));
		writeFileSync(
			join(ws, ".8gent", "allow-loopback.json"),
			JSON.stringify({ allow: ["127.0.0.1:4321"] }),
		);
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			workspace: ws,
			env: {},
			resolve: publicDns,
		});
		const out = await b.open(at("http", "127.0.0.1:4321/"));
		expect(out).toMatch(/failed|Refused/);
		expect(out).toContain("Ignored .8gent/allow-loopback.json");
		expect(site.calls).not.toContain("nav.go");
	});
	test("an isolated profile with only the env list opens just the listed port, no workspace needed", async () => {
		const env: Record<string, string> = { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:5173" };
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			env,
			resolve: publicDns,
		});
		expect(await b.open(at("http", "127.0.0.1:5173/"))).not.toMatch(/failed/);
		expect(await b.open(at("http", "127.0.0.1:5175/"))).toMatch(/failed|Refused/);
	});
	test("the non-isolated path is unchanged: its own allowLoopback list, no workspace needed", async () => {
		const site = nextSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			allowLoopback: ["127.0.0.1:5"],
			resolve: publicDns,
		});
		expect(await b.open(at("http", "127.0.0.1:5/"))).not.toMatch(/failed/);
		expect(await b.open(at("http", "127.0.0.1:6/"))).toMatch(/Refused/);
	});
});

describe("isolated profile: a password field is typed into only on an allowed loopback tab (#3785)", () => {
	afterEach(() => _resetLoopbackAllowlistForTest());
	const ws = () => mkdtempSync(join(tmpdir(), "8b-pw-ws-"));
	/** fakeSite's login form lives at http://127.0.0.1:5/; answer the secret-field probes for it. */
	function loginSite() {
		const site = fakeSite();
		const call: BrowserCall = async (cmd, args = {}) => {
			const sel = typeof args.selector === "string" ? args.selector : "";
			if (cmd === "page.query" && sel.startsWith("input[type=password],"))
				return site.call("page.query", { ...args, selector: "input[type=password]" });
			if (cmd === "page.type" && typeof args.index === "number") {
				const selector = args.index === 1 ? "input[type=password]" : "input[name=username]";
				return site.call("page.type", { ...args, selector });
			}
			return withSecretFields(site.call)(cmd, args);
		};
		return { call, calls: site.calls };
	}

	test("allowed loopback tab: the password is typed (by selector and by index), still logged as length only", async () => {
		const site = loginSite();
		const b = createEightBrowser(site.call, {
			settleMs: 0,
			isolated: true,
			workspace: ws(),
			env: { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:5" },
		});
		expect(await b.open("http://127.0.0.1:5/")).not.toMatch(/failed/);
		const out = JSON.parse(
			await b.run([
				{ action: "type", selector: "input[type=password]", text: "hunter2" },
				{ action: "type", index: 1, text: "hunter3" },
			]),
		);
		expect(out.ok).toBe(true);
		expect(out.steps.map((s: { ok: boolean; verified: boolean }) => [s.ok, s.verified])).toEqual([
			[true, true],
			[true, true],
		]);
		expect(out.steps[1].index).toBe(1);
		expect(out.steps[1].text_len).toBe(7);
		expect(JSON.stringify(out)).not.toMatch(/hunter/);
		expect(site.calls.filter((c) => c.cmd === "page.type").length).toBe(2);
	});
	test("any other page: refused by selector and by index, nothing typed", async () => {
		for (const env of [{}, { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:6" }]) {
			const site = fakeSite();
			// The tab is at https://example.com/ as far as the driver can tell.
			const call: BrowserCall = async (cmd, args = {}) => {
				if (cmd === "page.read")
					return { snapshot: { url: "https://example.com/login", title: "x", text: "" } };
				const sel = typeof args.selector === "string" ? args.selector : "";
				if (cmd === "page.query" && sel.startsWith("input[type=password],"))
					return site.call("page.query", { ...args, selector: "input[type=password]" });
				return withSecretFields(site.call)(cmd, args);
			};
			const b = createEightBrowser(call, { settleMs: 0, isolated: true, workspace: ws(), env });
			await b.open("https://example.com/login");
			for (const step of [
				{ action: "type", selector: "input[type=password]", text: "hunter2" },
				{ action: "type", index: 1, text: "hunter2" },
			]) {
				const out = JSON.parse(await b.run([step]));
				expect(out.ok).toBe(false);
				expect(out.error).toMatch(/password or payment field/);
			}
			expect(site.calls.some((c) => c.cmd === "page.type")).toBe(false);
			_resetLoopbackAllowlistForTest();
		}
	});
	test("a plan that moves from an allowed loopback page to another page is refused at the live check", async () => {
		const site = loginSite();
		let url = "http://127.0.0.1:5/";
		const call: BrowserCall = async (cmd, args = {}) => {
			if (cmd === "nav.go") url = String(args.url);
			if (cmd === "page.read") return { snapshot: { url, title: "x", text: "" } };
			return site.call(cmd, args);
		};
		const b = createEightBrowser(call, {
			settleMs: 0,
			isolated: true,
			workspace: ws(),
			env: { EIGHT_BROWSER_ALLOW_LOOPBACK: "127.0.0.1:5" },
		});
		await b.open("http://127.0.0.1:5/");
		const out = JSON.parse(
			await b.run([
				{ action: "open", url: "https://example.com/login" },
				{ action: "type", selector: "input[type=password]", text: "hunter2" },
			]),
		);
		expect(out.ok).toBe(false);
		expect(out.error).toMatch(/step 1: .*password or payment field/);
		expect(site.calls.some((c) => c.cmd === "page.type")).toBe(false);
	});
});

describe('element lines read `[n] role "name"`; type accepts an index (#4043)', () => {
	test("roles come from the tag, an input type or the ARIA role; the name is quoted and clipped as before", async () => {
		const els = [
			{ index: 0, tag: "a", text: "Docs", rect: { x: 0, y: 0, w: 9, h: 9 } },
			{ index: 1, tag: "button", text: "Save", rect: { x: 0, y: 10, w: 9, h: 9 } },
			{ index: 2, tag: "input", text: "", rect: { x: 0, y: 20, w: 9, h: 9 } },
			{ index: 3, tag: "input", text: "Weekly", rect: { x: 0, y: 30, w: 9, h: 9 } },
			{ index: 4, tag: "div", role: "button", text: "Go", rect: { x: 0, y: 40, w: 9, h: 9 } },
			{ index: 5, tag: "select", text: "Plan", rect: { x: 0, y: 50, w: 9, h: 9 } },
			{ index: 6, tag: "input", text: "Search", rect: { x: 0, y: 60, w: 9, h: 9 } },
		];
		const call: BrowserCall = async (cmd, args = {}) => {
			if (cmd === "tab.open") return { id: "t1" };
			if (cmd === "page.waitFor") return { ok: true, found: true };
			if (cmd === "page.read")
				return { snapshot: { url: "https://example.com/", title: "x", text: "" } };
			if (cmd === "page.query") {
				const sel = String(args.selector ?? "");
				if (sel === ":checked") return { ok: true, elements: [els[3]] };
				if (sel.startsWith("input[type=checkbox]")) return { ok: true, elements: [els[3]] };
				if (sel.startsWith("input[type=submit]")) return { ok: true, elements: [els[6]] };
				if (sel) return { ok: true, elements: [] };
				return { ok: true, elements: els };
			}
			throw new Error(`unexpected ${cmd}`);
		};
		const out = JSON.parse(
			await createEightBrowser(call, { settleMs: 0 }).open("https://example.com/"),
		);
		expect(out.elements).toEqual([
			'[0] link "Docs"',
			'[1] button "Save"',
			'[2] textbox ""',
			'[3] checkbox "Weekly" (checked)',
			'[4] button "Go"',
			'[5] combobox "Plan"',
			'[6] button "Search"',
		]);
	});
	test("type by index lands and is verified against the element list; a bad index is refused in the dry run", async () => {
		const site = fakeSite();
		const call: BrowserCall = async (cmd, args = {}) =>
			cmd === "page.type" && typeof args.index === "number"
				? site.call("page.type", {
						...args,
						selector: args.index === 1 ? "input[type=password]" : "input[name=username]",
					})
				: site.call(cmd, args);
		const b = createEightBrowser(call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const out = JSON.parse(await b.run([{ action: "type", index: 0, text: "rishi" }]));
		expect(out.ok).toBe(true);
		expect(out.steps[0]).toMatchObject({ action: "type", index: 0, text_len: 5, verified: true });
		expect(out.page.elements[0]).toBe("[0] textbox (typed, 5 chars)");
		const bad = JSON.parse(await b.run([{ action: "type", index: 9, text: "x" }]));
		expect(bad.ok).toBe(false);
		expect(bad.error).toMatch(/dry run: step 0: index 9 out of range/);
		expect(validateBrowserAction({ action: "type", text: "x" }).ok).toBe(false);
		expect(validateBrowserAction({ action: "type", index: -1, text: "x" }).ok).toBe(false);
		expect(validateBrowserAction({ action: "type", index: 2, text: "x" })).toEqual({
			ok: true,
			action: { action: "type", index: 2, text: "x" },
		});
	});
	test("type by index: a verify that never lands stops the plan, as with a selector", async () => {
		const site = fakeSite({ dropTyping: true });
		const call: BrowserCall = async (cmd, args = {}) =>
			cmd === "page.type" && typeof args.index === "number"
				? site.call("page.type", { ...args, selector: "input[name=username]" })
				: site.call(cmd, args);
		const b = createEightBrowser(call, { settleMs: 0, allowLoopback: ["127.0.0.1:5"] });
		await b.open("http://127.0.0.1:5/");
		const out = JSON.parse(
			await b.run([
				{ action: "type", index: 0, text: "rishi" },
				{ action: "left_click", index: 2 },
			]),
		);
		expect(out.ok).toBe(false);
		expect(out.steps[0]).toMatchObject({ attempts: 2, verified: false });
		expect(site.calls.some((c) => c.cmd === "page.click")).toBe(false);
	});
});

describeNotWin("ToolExecutor on the default local profile (#3785)", () => {
	const dir = mkdtempSync(join(tmpdir(), "browser-local-default-"));
	const saved = {
		profile: process.env.EIGHT_BROWSER_PROFILE,
		headless: process.env.EIGHT_HEADLESS,
	};
	const restore = (k: string, v: string | undefined) =>
		v === undefined ? Reflect.deleteProperty(process.env, k) : (process.env[k] = v);
	afterEach(() => {
		restore("EIGHT_BROWSER_PROFILE", saved.profile);
		restore("EIGHT_HEADLESS", saved.headless);
		setDefaultLocalProfile(null);
		_setProfileHomeForTest(null);
		_resetTuiApprovalChannel();
	});

	test("browser_open and browser_screenshot work with no EIGHT_BROWSER_PROFILE, through the eight-local profile", async () => {
		const site = nextSite();
		const shot: BrowserCall = async (cmd, args) =>
			cmd === "page.screenshot"
				? {
						ok: true,
						dataUrl: `data:image/png;base64,${pngHeader(800, 600).toString("base64")}`,
						savedTo: null,
					}
				: site.call(cmd, args);
		const { server, tokens } = serveCall(shot, "local-tok");
		try {
			Reflect.deleteProperty(process.env, "EIGHT_BROWSER_PROFILE");
			process.env.EIGHT_HEADLESS = "1";
			setDefaultLocalProfile(LOCAL_BROWSER_PROFILE);
			_setProfileHomeForTest(profileHome("eight-local", { token: "local-tok", port: server.port }));
			const exec = new ToolExecutor(dir, "browser-local");
			const opened = await exec.execute("browser_open", { url: "https://example.com/" });
			expect(opened).not.toMatch(/failed/);
			expect(tokens.length).toBeGreaterThan(0); // one authenticated round trip per command
			expect(new Set(tokens)).toEqual(new Set(["local-tok"]));
			const out = await exec.execute("browser_screenshot", {});
			expect(out.startsWith(dir)).toBe(true);
			expect(out.endsWith(" 800x600")).toBe(true);
			// Still an isolated profile: loopback off the list is refused before the browser is asked.
			const before = site.calls.length;
			expect(await exec.execute("browser_open", { url: "http://127.0.0.1:5173/" })).toMatch(
				/browser_open failed/,
			);
			expect(site.calls.length).toBe(before);
		} finally {
			server.stop(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
