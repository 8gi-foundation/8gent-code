import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../../eight/tools";
import {
	type TuiApprovalDecision,
	type TuiApprovalRequest,
	_resetTuiApprovalChannel,
	registerTuiApprovalHandler,
} from "../../permissions/tui-approval-channel";
import { type BrowserCall, createEightBrowser, validateBrowserAction, wsTransport } from "../eight-browser";

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
					{ index: 0, tag: "input", text: clip(values["input[name=username]"]), rect: { x: 0, y: 0, w: 9, h: 9 } },
					{ index: 1, tag: "input", text: clip(values["input[type=password]"]), rect: { x: 0, y: 10, w: 9, h: 9 } },
					{ index: 2, tag: "button", text: "Sign in", rect: { x: 0, y: 20, w: 9, h: 9 } },
				]
			: [
					{ index: 0, tag: "input", text: "on", rect: { x: 0, y: 0, w: 9, h: 9 } },
					{ index: 1, tag: "button", text: "Save", rect: { x: 0, y: 10, w: 9, h: 9 } },
					{ index: 2, tag: "button", text: "Delete account", rect: { x: 0, y: 20, w: 9, h: 9 }, sel: "#danger" },
					{ index: 3, tag: "button", text: "x", rect: { x: 0, y: 30, w: 9, h: 9 }, sel: "#close", aria: "Remove widget" },
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
				if (args.selector === "input[type=password]" && page === "login") return { ok: true, elements: [all[1]], count: 1 };
				if (typeof args.selector === "string" && args.selector.startsWith("[aria-label*=")) {
					const q = String(args.selector).toLowerCase();
					const hits = all.filter((e) => "aria" in e && e.aria && e.aria.toLowerCase().split(" ").some((w) => q.includes(`"${w}"`)));
					return { ok: true, elements: hits, count: hits.length };
				}
				const bySel = all.filter((e) => "sel" in e && e.sel === args.selector);
				if (bySel.length) return { ok: true, elements: bySel, count: 1 };
				if (typeof args.selector === "string" && args.selector.startsWith("input[")) {
					return { ok: true, elements: [{ index: 0, tag: "input", text: clip(values[args.selector as string]) }], count: 1 };
				}
				if (typeof args.selector === "string") return { ok: true, elements: [], count: 0 };
				return { ok: true, elements: all, count: all.length };
			}
			case "page.type":
				if (!opts.dropTyping) values[args.selector as string] = String(args.text);
				return { ok: true, typed: true };
			case "page.click": {
				const el = typeof args.index === "number" ? els()[args.index] : els().find((e) => "sel" in e && e.sel === args.selector);
				if (!el) return { ok: false, error: "index out of range" };
				if (page === "login" && el.text === "Sign in") page = "settings";
				else if (page === "settings" && el.index === 0) checked = !checked;
				else if (page === "settings" && el.text === "Save") saved = checked ? "on" : "off";
				return { ok: true, clicked: true };
			}
			case "page.screenshot":
				return { ok: true, dataUrl: `data:image/png;base64,${Buffer.from("PNGBYTES").toString("base64")}`, savedTo: null };
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
		expect(validateBrowserAction({ action: "eval", js: "1" })).toEqual({ ok: false, error: "unknown action kind: eval" });
		expect(validateBrowserAction({ action: "left_click" }).ok).toBe(false);
		expect(validateBrowserAction({ action: "type", selector: "input", text: "x".repeat(4001) }).ok).toBe(false);
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
		const approve = async (what: string) => (asked.push(what), true);
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
		expect(res.steps.map((s: { verified: boolean }) => s.verified)).toEqual([true, true, true, true, true]);
		expect(site.state().saved).toBe("on");
		// Typed text never echoes back to the model or the log: length only.
		expect(out).not.toContain("s3cret-pass");
		expect(res.steps[1].text_len).toBe(11);
	});

	test("dry run refuses the whole plan before acting when a target is out of range", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		const res = JSON.parse(await b.run([{ action: "type", selector: "input[name=username]", text: "a" }, { action: "left_click", index: 9 }]));
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
		const no = async (what: string) => (asked.push(what), false);
		for (const a of [{ action: "left_click", index: 2 }, { action: "left_click", selector: "#danger" }, { action: "left_click", selector: "#close" }]) {
			const res = JSON.parse(await b.run([a], undefined, no));
			expect(res.ok).toBe(false);
			expect(res.error).toMatch(/declined/);
		}
		expect(asked).toEqual(['click "Delete account" (destructive)', 'click "Delete account" (destructive)', 'click "x" (destructive)']);
		// With no approver at all, a sensitive click is refused, never run.
		expect(JSON.parse(await b.run([{ action: "left_click", index: 2 }])).error).toMatch(/needs approval/);
		expect(clicks()).toBe(1);
		// A selector that matches nothing is refused before any click.
		expect(JSON.parse(await b.run([{ action: "left_click", selector: "#nope" }], undefined, yes)).error).toMatch(/no element/);
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
		const res = JSON.parse(await b.run([{ action: "type", selector: "input[name=username]", text: "rishi" }, { action: "left_click", index: 2 }]));
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
		const res = JSON.parse(await b.run([{ action: "type", selector: "input[name=username]", text: long }]));
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
		const b = createEightBrowser(fakeSite({ prefilledPassword: "autofilled-pw" }).call, { settleMs: 0 });
		const out = await b.open("http://127.0.0.1:5/");
		expect(out).not.toContain("autofilled-pw");
		expect(JSON.parse(out).elements[1]).toBe("[1] input (password field)");
	});

	test("typed values are never echoed back through the element list", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		const out = await b.run([{ action: "type", selector: "input[type=password]", text: "s3cret-pass" }]);
		expect(out).not.toContain("s3cret-pass");
		expect(await b.state()).not.toContain("s3cret-pass");
		expect(JSON.parse(await b.state()).elements[1]).toBe("[1] input (password field)");
		const out2 = await b.run([{ action: "type", selector: "input[name=username]", text: "rishi-user" }]);
		expect(out2).not.toContain("rishi-user");
		expect(JSON.parse(await b.state()).elements[0]).toBe("[0] input (typed, 10 chars)");
	});

	test("hides invisible elements (a hidden csrf value never reaches the model) and keeps indices stable", async () => {
		const call: BrowserCall = async (cmd, args = {}) => {
			if (cmd === "tab.open") return { id: "t9" };
			if (cmd === "page.waitFor") return { ok: true, found: true };
			if (cmd === "page.read") return { snapshot: { url: "http://127.0.0.1:5/", title: "x", text: "" } };
			if (cmd === "page.query" && args.selector === "input[name=csrf]") return { ok: true, elements: [{ index: 0, tag: "input", text: "", visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } }] };
			if (cmd === "page.query" && typeof args.selector === "string") return { ok: true, elements: [] };
			return {
				ok: true,
				elements: [
					{ index: 0, tag: "input", text: "", visible: true },
					{ index: 1, tag: "input", text: "csrf-secret-value", visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } },
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
		expect(JSON.parse(await b2.run([{ action: "left_click", selector: "input[name=csrf]" }])).error).toMatch(/hidden/);
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
					if (m.type === "auth") reply = m.token === "tok-123" ? { type: "auth_ok" } : { type: "error", error: "bad token" };
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
	afterEach(() => {
		_resetTuiApprovalChannel();
		if (prevHeadless === undefined) Reflect.deleteProperty(process.env, "EIGHT_HEADLESS");
		else process.env.EIGHT_HEADLESS = prevHeadless;
	});
	const card = (answer: TuiApprovalDecision) => {
		const asked: TuiApprovalRequest[] = [];
		registerTuiApprovalHandler(async (req) => (asked.push(req), answer));
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
		const out = await new ToolExecutor(dir, "browser-gate-test").execute("browser_task", { actions: [{ action: "scroll", dy: 10 }] });
		expect(out).toContain("[BLOCKED]");
	});

	test("browser_open is gated as network_request", async () => {
		const out = await new ToolExecutor(dir, "browser-gate-test").execute("browser_open", { url: "https://pastebin.com/raw/x" });
		expect(out).toMatch(/exfil/i);
		expect(out).not.toContain('"tab"');
	});

	test("browser_screenshot writes only a .png inside the workspace or ~/.8gent/browser-shots", async () => {
		card("approve");
		const exec = new ToolExecutor(dir, "browser-gate-test");
		expect(await exec.execute("browser_screenshot", { path: "/etc/evil.png" })).toMatch(/browser_screenshot failed: .*(outside|blocked)/i);
		expect(await exec.execute("browser_screenshot", { path: "shot.jpg" })).toMatch(/\.png/);
	});
});
