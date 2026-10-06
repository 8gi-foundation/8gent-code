import { describe, expect, test } from "bun:test";
import { type BrowserCall, createEightBrowser, validateBrowserAction } from "../eight-browser";

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
					{ index: 0, tag: "input", text: values["input[name=username]"] ?? "" },
					{ index: 1, tag: "input", text: values["input[type=password]"] ?? "" },
					{ index: 2, tag: "button", text: "Sign in" },
				]
			: [
					{ index: 0, tag: "input", text: "on" },
					{ index: 1, tag: "button", text: "Save" },
					{ index: 2, tag: "button", text: "Delete account" },
				];
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
				if (typeof args.selector === "string") {
					return { ok: true, elements: all.filter((e) => e.tag === "input").slice(0, 1).map(() => ({ tag: "input", text: values[args.selector as string] ?? "" })), count: 1 };
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
		expect(res.steps.map((s: { verified: boolean }) => s.verified)).toEqual([true, true, true, false, true]);
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
});
