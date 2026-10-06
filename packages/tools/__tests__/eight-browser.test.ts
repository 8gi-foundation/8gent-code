import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BrowserCall, createEightBrowser, validateBrowserAction, wsTransport } from "../eight-browser";

// A fake 8gent Browser control channel that behaves like the pilot fixture:
// a login form, then a settings page with a checkbox and a Save button.
function fakeSite(opts: { dropTyping?: boolean } = {}) {
	const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
	let page: "login" | "settings" = "login";
	const values: Record<string, string> = {};
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
					{ index: 2, tag: "button", text: "Delete account", rect: { x: 0, y: 20, w: 9, h: 9 } },
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
				if (typeof args.selector === "string") {
					return { ok: true, elements: [{ index: 0, tag: "input", text: clip(values[args.selector as string]) }], count: 1 };
				}
				return { ok: true, elements: all, count: all.length };
			}
			case "page.type":
				if (!opts.dropTyping) values[args.selector as string] = String(args.text);
				return { ok: true, typed: true };
			case "page.click": {
				const el = els()[args.index as number];
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
	return { call, calls, state: () => ({ page, saved, checked }) };
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
		const out = await b.run([
			{ action: "type", selector: "input[name=username]", text: "rishi" },
			{ action: "type", selector: "input[type=password]", text: "s3cret-pass" },
			{ action: "left_click", index: 2 },
			{ action: "left_click", index: 0 },
			{ action: "left_click", index: 1 },
		]);
		const res = JSON.parse(out);
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

	test("refuses a destructive click without touching the page", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		await b.run([{ action: "left_click", index: 2 }]);
		const res = JSON.parse(await b.run([{ action: "left_click", index: 2 }]));
		expect(res.ok).toBe(false);
		expect(res.error).toMatch(/destructive/);
		expect(site.calls.filter((c) => c.cmd === "page.click").length).toBe(1);
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
	test("typed values are never echoed back through the element list", async () => {
		const site = fakeSite();
		const b = createEightBrowser(site.call, { settleMs: 0 });
		await b.open("http://127.0.0.1:5/");
		const out = await b.run([{ action: "type", selector: "input[type=password]", text: "s3cret-pass" }]);
		expect(out).not.toContain("s3cret-pass");
		expect(await b.state()).not.toContain("s3cret-pass");
		expect(JSON.parse(await b.state()).elements[1]).toBe("[1] input (typed, 11 chars)");
	});

	test("hides invisible elements (a hidden csrf value never reaches the model) and keeps indices stable", async () => {
		const call: BrowserCall = async (cmd, args = {}) => {
			if (cmd === "tab.open") return { id: "t9" };
			if (cmd === "page.waitFor") return { ok: true, found: true };
			if (cmd === "page.read") return { snapshot: { url: "http://127.0.0.1:5/", title: "x", text: "" } };
			if (cmd === "page.query" && args.selector === ":checked") return { ok: true, elements: [] };
			return {
				ok: true,
				elements: [
					{ index: 0, tag: "input", text: "", visible: true },
					{ index: 1, tag: "input", text: "csrf-secret-value", visible: false },
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
					ws.send(JSON.stringify(reply));
				},
			},
		});
		try {
			const call = wsTransport({ port: server.port, tokenFile: join(dir, "token") });
			expect(await call("tabs.list", { a: 1 })).toEqual({ echoed: "tabs.list", args: { a: 1 } });
			await expect(call("boom")).rejects.toThrow("nope");
			expect(seen[0]).toEqual({ type: "auth", token: "tok-123" });
			const bad = wsTransport({ port: server.port, tokenFile: join(dir, "missing") });
			await expect(bad("tabs.list")).rejects.toThrow(/token not found/);
		} finally {
			server.stop(true);
		}
	});
});
