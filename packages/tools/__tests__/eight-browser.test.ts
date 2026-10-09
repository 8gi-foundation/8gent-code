import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../../eight/tools";
import {
	type TuiApprovalDecision,
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../../permissions/tui-approval-channel";
import {
	type BrowserCall,
	_setProfileHomeForTest,
	browserProfile,
	blockedForProfile,
	browserProfileWarning,
	touchesBrowserSecrets,
	createEightBrowser,
	localBrowserTools,
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
					dataUrl: `data:image/png;base64,${Buffer.from("PNGBYTES").toString("base64")}`,
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
		const b = createEightBrowser(site.call, { settleMs: 0 });
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
		const b = createEightBrowser(site.call, { settleMs: 0 });
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
		const b = createEightBrowser(site.call, { settleMs: 0 });
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
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		await b.closeAll();
		expect(site.closed).toEqual(["t1"]);
		expect(await b.state()).toMatch(/not opened by 8gent/);
	});

	test("verify-after-act retries a type that did not land, then stops the plan", async () => {
		const site = fakeSite({ dropTyping: true });
		const b = createEightBrowser(site.call, { settleMs: 0 });
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
		const b = createEightBrowser(fakeSite().call, { settleMs: 0 });
		expect(await b.state("someone-elses-tab")).toMatch(/not opened by 8gent/);
	});

	test("a type verifies against 8gent Browser's clipped text, not the raw string", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		const long = `  two  spaces ${"x".repeat(200)}`;
		const res = JSON.parse(
			await b.run([{ action: "type", selector: "input[name=username]", text: long }]),
		);
		expect(res.steps[0]).toMatchObject({ verified: true, attempts: 1 });
	});

	test("screenshot writes the tab's PNG to the requested path", async () => {
		const b = createEightBrowser(fakeSite().call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		const out = join(mkdtempSync(join(tmpdir(), "8b-shot-")), "s.png");
		expect(await b.screenshot(out)).toBe(out);
		expect(readFileSync(out, "utf8")).toBe("PNGBYTES");
		expect(await b.screenshot(out, "not-mine")).toMatch(/not opened by 8gent/);
	});
});

describe("state rendering", () => {
	test("password fields are always masked, even when the agent did not type them", async () => {
		const b = createEightBrowser(fakeSite({ prefilledPassword: "autofilled-pw" }).call, {
			settleMs: 0,
		});
		const out = await b.open("http://127.0.0.1:5/");
		expect(out).not.toContain("autofilled-pw");
		expect(JSON.parse(out).elements[1]).toBe("[1] input (password field)");
	});

	test("typed values are never echoed back through the element list", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		const out = await b.run([
			{ action: "type", selector: "input[type=password]", text: "s3cret-pass" },
		]);
		expect(out).not.toContain("s3cret-pass");
		expect(await b.state()).not.toContain("s3cret-pass");
		expect(JSON.parse(await b.state()).elements[1]).toBe("[1] input (password field)");
		const out2 = await b.run([
			{ action: "type", selector: "input[name=username]", text: "rishi-user" },
		]);
		expect(out2).not.toContain("rishi-user");
		expect(JSON.parse(await b.state()).elements[0]).toBe("[0] input (typed, 10 chars)");
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
		const out = await createEightBrowser(call, { settleMs: 0 }).open("http://127.0.0.1:5/");
		expect(out).not.toContain("csrf-secret-value");
		expect(JSON.parse(out).elements).toEqual(["[0] input", "[2] button Sign in"]);
		const b2 = createEightBrowser(call, { settleMs: 0 });
		await b2.open("http://127.0.0.1:5/");
		expect(JSON.parse(await b2.run([{ action: "left_click", index: 1 }])).error).toMatch(/hidden/);
		expect(
			JSON.parse(await b2.run([{ action: "left_click", selector: "input[name=csrf]" }])).error,
		).toMatch(/hidden/);
	});
});

describe("wsTransport (real WebSocket round trip)", () => {
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

describe("wsTransport with a named profile", () => {
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

	test("fails closed, without connecting, when the profile is not running", async () => {
		const env = { EIGHT_BROWSER_PROFILE: "eightgent" };
		_setProfileHomeForTest(profileHome("eightgent", { token: "bot-tok" }));
		await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
			/profile "eightgent" is not running/,
		);
		_setProfileHomeForTest(profileHome("eightgent", { port: 7981 }));
		await expect(wsTransport({ env })("tabs.list")).rejects.toThrow(
			/profile "eightgent" is not running/,
		);
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

describe("ToolExecutor: named profile acts without a card; default profile still asks", () => {
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
});

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

	test("named profile: the sensitive-click card does not say 'your logged-in browser'", async () => {
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
	});

	test("named profile: a screenshot is saved in the workspace, never in the protected profile dir", async () => {
		const site = nextSite();
		const shot: BrowserCall = async (cmd, args) =>
			cmd === "page.screenshot"
				? {
						ok: true,
						dataUrl: `data:image/png;base64,${Buffer.from("PNG").toString("base64")}`,
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
			expect(readFileSync(out, "utf8")).toBe("PNG");
		} finally {
			server.stop(true);
		}
	});
});

// ── 8SO HIGH-2 follow-up: run_command backstop (a speed bump until #3612 seatbelts it) ──

describe("touchesBrowserSecrets: run_command may not reach the browser token or profiles", () => {
	const b64 = (t: string) => Buffer.from(t).toString("base64");
	const hex = (t: string) => Buffer.from(t).toString("hex");
	const refused = [
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
	];
	for (const cmd of allowed)
		test(`allows: ${cmd}`, () => expect(touchesBrowserSecrets(cmd)).toBe(false));
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
			expect(out).toMatch(/^\[PERMISSION DENIED\] Command touches 8gent Browser control tokens/);
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
		createEightBrowser(call, { settleMs: 0, secretsFile });
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
			["loose mode", "{{secret:APP_PW}}", () => write(0o644)],
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
