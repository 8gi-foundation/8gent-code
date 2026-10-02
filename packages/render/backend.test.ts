/**
 * @8gent/render backend interface (#3346 PR 2).
 *
 * The selection rules are tested against fake backends, so they run anywhere,
 * including inside the agent sandbox and on Linux CI. The Chrome backend's real
 * launch is gated on EIGHT_RENDER_E2E=1, because headless Chrome cannot start
 * inside the agent sandbox and a green skip must never stand in for it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BACKEND_PREFERENCE,
	type BackendName,
	type RenderBackend,
	RenderBackendUnavailableError,
	type RenderSession,
	selectBackend,
} from "./backend";
import { ChromeHeadlessBackend, chromeArgs, findChrome, slideUrl } from "./chrome";

/** A backend that records every call, so session order can be asserted. */
function fake(name: BackendName, ok: boolean, reason?: string) {
	const calls: string[] = [];
	const backend: RenderBackend = {
		name,
		async available() {
			calls.push("available");
			return ok ? { ok: true } : { ok: false, reason: reason ?? `${name} is off` };
		},
		async open(htmlPath, size) {
			calls.push(`open ${htmlPath} ${size.width}x${size.height}`);
			let shown = -1;
			const session: RenderSession = {
				async show(slide) {
					calls.push(`show ${slide}`);
					shown = slide;
				},
				async capture() {
					calls.push("capture");
					return new TextEncoder().encode(`${name}:${shown}`);
				},
				async close() {
					calls.push("close");
				},
			};
			return session;
		},
	};
	return { backend, calls };
}

describe("selectBackend: order", () => {
	test("prefers 8gent Browser over Chrome regardless of list order", async () => {
		const chrome = fake("chrome-headless", true);
		const eight = fake("8gent-browser", true);
		const picked = await selectBackend([chrome.backend, eight.backend], {});
		expect(picked.name).toBe("8gent-browser");
		// Chrome is never probed once the preferred backend answers.
		expect(chrome.calls).toEqual([]);
	});

	test("falls back to Chrome when 8gent Browser is unavailable", async () => {
		const eight = fake("8gent-browser", false, "8gent Browser is not open");
		const chrome = fake("chrome-headless", true);
		const picked = await selectBackend([eight.backend, chrome.backend], {});
		expect(picked.name).toBe("chrome-headless");
		expect(eight.calls).toEqual(["available"]);
	});

	test("the preference order is 8gent Browser first", () => {
		expect(BACKEND_PREFERENCE).toEqual(["8gent-browser", "chrome-headless"]);
	});

	test("a single registered backend is enough (PR 2 ships Chrome only)", async () => {
		const chrome = fake("chrome-headless", true);
		const picked = await selectBackend([chrome.backend], {});
		expect(picked.name).toBe("chrome-headless");
	});
});

describe("selectBackend: honest errors", () => {
	test("neither available: one error naming both reasons", async () => {
		const eight = fake("8gent-browser", false, "8gent Browser is not open");
		const chrome = fake("chrome-headless", false, "Chrome failed to start");
		const err = await selectBackend([eight.backend, chrome.backend], {}).catch((e) => e);
		expect(err).toBeInstanceOf(RenderBackendUnavailableError);
		expect(err.message).toContain("8gent-browser: 8gent Browser is not open");
		expect(err.message).toContain("chrome-headless: Chrome failed to start");
		expect(err.reasons).toEqual([
			{ name: "8gent-browser", reason: "8gent Browser is not open" },
			{ name: "chrome-headless", reason: "Chrome failed to start" },
		]);
	});

	test("no backends registered is an error, not a hang", async () => {
		const err = await selectBackend([], {}).catch((e) => e);
		expect(err).toBeInstanceOf(RenderBackendUnavailableError);
		expect(err.message).toContain("no render backend registered");
	});

	test("a throwing probe is reported as unavailable, not propagated", async () => {
		const broken: RenderBackend = {
			name: "8gent-browser",
			available: async () => {
				throw new Error("socket refused");
			},
			open: async () => {
				throw new Error("unreachable");
			},
		};
		const chrome = fake("chrome-headless", true);
		const picked = await selectBackend([broken, chrome.backend], {});
		expect(picked.name).toBe("chrome-headless");
	});
});

describe("selectBackend: EIGHT_RENDER_BACKEND", () => {
	test("forces the named backend even when a preferred one is available", async () => {
		const eight = fake("8gent-browser", true);
		const chrome = fake("chrome-headless", true);
		const picked = await selectBackend([eight.backend, chrome.backend], {
			EIGHT_RENDER_BACKEND: "chrome",
		});
		expect(picked.name).toBe("chrome-headless");
		expect(eight.calls).toEqual([]);
	});

	test("accepts the full backend name too", async () => {
		const chrome = fake("chrome-headless", true);
		const picked = await selectBackend([chrome.backend], {
			EIGHT_RENDER_BACKEND: "chrome-headless",
		});
		expect(picked.name).toBe("chrome-headless");
	});

	test("a forced backend that is unavailable fails; it never silently falls back", async () => {
		const eight = fake("8gent-browser", false, "8gent Browser is not open");
		const chrome = fake("chrome-headless", true);
		const err = await selectBackend([eight.backend, chrome.backend], {
			EIGHT_RENDER_BACKEND: "8gent-browser",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(RenderBackendUnavailableError);
		expect(err.message).toContain("8gent Browser is not open");
		expect(chrome.calls).toEqual([]);
	});

	test("an unknown value is an error naming the valid ones", async () => {
		const chrome = fake("chrome-headless", true);
		const err = await selectBackend([chrome.backend], { EIGHT_RENDER_BACKEND: "firefox" }).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(RenderBackendUnavailableError);
		expect(err.message).toContain("firefox");
		expect(err.message).toContain("8gent-browser");
		expect(err.message).toContain("chrome");
	});

	test("forcing a backend that is not registered is an error", async () => {
		const chrome = fake("chrome-headless", true);
		const err = await selectBackend([chrome.backend], {
			EIGHT_RENDER_BACKEND: "8gent-browser",
		}).catch((e) => e);
		expect(err).toBeInstanceOf(RenderBackendUnavailableError);
		expect(err.message).toContain("not registered");
	});
});

describe("session contract (fake backend)", () => {
	test("one open per deck, then show and capture per slide, then close", async () => {
		const eight = fake("8gent-browser", true);
		const backend = await selectBackend([eight.backend], {});
		const session = await backend.open("/decks/a.html", { width: 1920, height: 1080 });
		const frames: string[] = [];
		for (const k of [0, 1, 2]) {
			await session.show(k);
			frames.push(new TextDecoder().decode(await session.capture()));
		}
		await session.close();
		expect(frames).toEqual(["8gent-browser:0", "8gent-browser:1", "8gent-browser:2"]);
		expect(eight.calls).toEqual([
			"available",
			"open /decks/a.html 1920x1080",
			"show 0",
			"capture",
			"show 1",
			"capture",
			"show 2",
			"capture",
			"close",
		]);
	});
});

describe("source guards", () => {
	// 8gent Browser's tabs.list throws on the installed build (8TO probe, 2 Oct 2026).
	// No file in this package may call it, including the PR 3 driver.
	test("no file in packages/render calls tabs.list", () => {
		expect(/["'`]tabs\.list["'`]|\btabs\.list\s*\(/.test('send({ cmd: "tabs.list" })')).toBe(true);
		const dir = import.meta.dir;
		const offenders = readdirSync(dir)
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
			// A command literal ("tabs.list") or a call (tabs.list(...)); prose in comments is fine.
			.filter((f) =>
				/["'`]tabs\.list["'`]|\btabs\.list\s*\(/.test(readFileSync(join(dir, f), "utf8")),
			);
		expect(offenders).toEqual([]);
	});
});

describe("Chrome backend: pure parts", () => {
	test("slideUrl adds #slide=k only once a slide is shown", () => {
		expect(slideUrl("/tmp/deck.html", null)).toBe("file:///tmp/deck.html");
		expect(slideUrl("/tmp/deck.html", 3)).toBe("file:///tmp/deck.html#slide=3");
	});

	test("chromeArgs carries the size, the isolated profile and the settle budget", () => {
		const args = chromeArgs("file:///tmp/d.html#slide=1", "/tmp/out.png", "/tmp/prof", {
			width: 1280,
			height: 720,
		});
		expect(args).toContain("--headless=new");
		expect(args).toContain("--window-size=1280,720");
		expect(args).toContain("--user-data-dir=/tmp/prof");
		expect(args).toContain("--screenshot=/tmp/out.png");
		expect(args).toContain("--virtual-time-budget=2000");
		expect(args).toContain("--force-device-scale-factor=1");
		expect(args[args.length - 1]).toBe("file:///tmp/d.html#slide=1");
	});

	test("findChrome honours EIGHT_CHROME_PATH and refuses a missing override", () => {
		expect(findChrome({ EIGHT_CHROME_PATH: "/bin/sh" })).toBe("/bin/sh");
		expect(findChrome({ EIGHT_CHROME_PATH: "/nonexistent/chrome" })).toBeNull();
	});

	test("available() is honest when no Chrome binary exists", async () => {
		const backend = new ChromeHeadlessBackend({
			env: { EIGHT_CHROME_PATH: "/nonexistent/chrome" },
		});
		const r = await backend.available();
		expect(r.ok).toBe(false);
		expect(r.reason).toContain("/nonexistent/chrome");
	});

	test("open() refuses a deck that does not exist", async () => {
		const backend = new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: "/bin/sh" } });
		const err = await backend
			.open("/nonexistent/deck.html", { width: 10, height: 10 })
			.catch((e) => e);
		expect(err).toBeInstanceOf(Error);
		expect(String(err.message)).toContain("/nonexistent/deck.html");
	});

	test("close() removes the session's temp directory, and a closed session refuses work", async () => {
		const backend = new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: "/bin/sh" } });
		const work = mkdtempSync(join(tmpdir(), "render-unit-"));
		try {
			const deck = join(work, "d.html");
			writeFileSync(deck, "<html><body>x</body></html>");
			const session = await backend.open(deck, { width: 64, height: 64 });
			const dir = (session as unknown as { workDir: string }).workDir;
			expect(existsSync(dir)).toBe(true);
			await session.close();
			expect(existsSync(dir)).toBe(false);
			await session.close();
			expect(await session.show(1).catch((e) => e.message)).toContain("closed");
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});

// Real path. Outside the sandbox: EIGHT_RENDER_E2E=1 bun test packages/render
describe.skipIf(process.env.EIGHT_RENDER_E2E !== "1")(
	"Chrome backend: real launch (EIGHT_RENDER_E2E=1)",
	() => {
		test("available, then two different slides give two different PNGs", async () => {
			const work = mkdtempSync(join(tmpdir(), "render-e2e-"));
			try {
				const deck = join(work, "deck.html");
				writeFileSync(
					deck,
					`<!doctype html><html><body style="margin:0"><div id="s"></div><script>
				function show(){var m=(location.hash.match(/slide=(\\d+)/)||[])[1]||"0";
				document.body.style.background=m==="0"?"#000":"#fff";document.getElementById("s").textContent=m;}
				show();</script></body></html>`,
				);
				const backend = new ChromeHeadlessBackend();
				const avail = await backend.available();
				expect(avail).toEqual({ ok: true });
				const session = await backend.open(deck, { width: 320, height: 180 });
				await session.show(0);
				const a = await session.capture();
				await session.show(1);
				const b = await session.capture();
				await session.close();
				const PNG = [0x89, 0x50, 0x4e, 0x47];
				expect([...a.slice(0, 4)]).toEqual(PNG);
				expect([...b.slice(0, 4)]).toEqual(PNG);
				expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
			} finally {
				rmSync(work, { recursive: true, force: true });
			}
		}, 120_000);
	},
);
