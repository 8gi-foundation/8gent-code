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

/**
 * A stand-in Chrome: a shell script that takes Chrome's argv, records it next to
 * itself, writes a PNG header to --screenshot= and then behaves as `tail` says.
 * It runs the real spawn, process-group and temp-dir code with no Chrome at all,
 * so these tests run inside the sandbox and on CI.
 */
function fakeChrome(dir: string, tail: string): string {
	const script = join(dir, "fake-chrome.sh");
	writeFileSync(
		script,
		`#!/bin/sh
here="$(cd "$(dirname "$0")" && pwd)"
for a in "$@"; do
	case "$a" in
		--screenshot=*) png="\${a#--screenshot=}" ;;
		--user-data-dir=*) prof="\${a#--user-data-dir=}" ;;
	esac
done
printf '%s\\n' "$@" > "$here/args.txt"
printf '%s' "$prof" > "$here/profile.txt"
printf '%s' "$$" > "$here/leader.pid"
mkdir -p "$prof"
printf '\\211PNG' > "$png"
${tail}
`,
		{ mode: 0o755 },
	);
	return script;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(cond: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (cond()) return true;
		await Bun.sleep(25);
	}
	return cond();
}

const NETWORK_FLAGS = [
	"--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost",
	"--proxy-server=127.0.0.1:9",
];

describe("Chrome backend: deck network is blocked by default (8SO R1)", () => {
	const size = { width: 8, height: 8 };

	test("chromeArgs carries both network-block flags by default", () => {
		const args = chromeArgs("file:///tmp/d.html", "/tmp/o.png", "/tmp/p", size);
		for (const flag of NETWORK_FLAGS) expect(args).toContain(flag);
		expect(args[args.length - 1]).toBe("file:///tmp/d.html");
	});

	test("chromeArgs drops them only when allowNetwork is true", () => {
		const off = chromeArgs("file:///tmp/d.html", "/tmp/o.png", "/tmp/p", size, {
			allowNetwork: false,
		});
		for (const flag of NETWORK_FLAGS) expect(off).toContain(flag);
		const on = chromeArgs("file:///tmp/d.html", "/tmp/o.png", "/tmp/p", size, {
			allowNetwork: true,
		});
		for (const flag of NETWORK_FLAGS) expect(on).not.toContain(flag);
		expect(
			on.some((a) => a.startsWith("--host-resolver-rules") || a.startsWith("--proxy-server")),
		).toBe(false);
	});

	test("the flags reach the launched process; allowNetwork on the backend removes them", async () => {
		const work = mkdtempSync(join(tmpdir(), "render-net-"));
		try {
			const deck = join(work, "d.html");
			writeFileSync(deck, "<html></html>");
			const script = fakeChrome(work, "exit 0");
			const argv = () => readFileSync(join(work, "args.txt"), "utf8").split("\n");

			const locked = await new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: script } }).open(
				deck,
				size,
			);
			try {
				await locked.capture();
			} finally {
				await locked.close();
			}
			for (const flag of NETWORK_FLAGS) expect(argv()).toContain(flag);

			const open = await new ChromeHeadlessBackend({
				env: { EIGHT_CHROME_PATH: script },
				allowNetwork: true,
			}).open(deck, size);
			try {
				await open.capture();
			} finally {
				await open.close();
			}
			for (const flag of NETWORK_FLAGS) expect(argv()).not.toContain(flag);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});
});

describe("Chrome backend: process and temp-dir edges (8SO R3)", () => {
	const size = { width: 8, height: 8 };

	test("helpers left in the group are killed even after the leader has exited", async () => {
		const work = mkdtempSync(join(tmpdir(), "render-grp-"));
		try {
			const deck = join(work, "d.html");
			writeFileSync(deck, "<html></html>");
			// The leader exits on its own (no "bytes written" line), leaving a helper behind.
			const script = fakeChrome(
				work,
				`sleep 30 >/dev/null 2>&1 &
printf '%s' "$!" > "$here/helper.pid"
exit 0`,
			);
			const session = await new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: script } }).open(
				deck,
				size,
			);
			try {
				await session.capture();
			} finally {
				await session.close();
			}
			const helper = Number(readFileSync(join(work, "helper.pid"), "utf8"));
			expect(helper).toBeGreaterThan(0);
			expect(await waitUntil(() => !alive(helper), 2000)).toBe(true);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	test("a Chrome that ignores SIGTERM is hard-killed, and capture waits for it to exit", async () => {
		const work = mkdtempSync(join(tmpdir(), "render-kill-"));
		try {
			const deck = join(work, "d.html");
			writeFileSync(deck, "<html></html>");
			// Like recent macOS Chrome: prints, then lingers. This one also ignores SIGTERM.
			const script = fakeChrome(
				work,
				`trap '' TERM
echo "4 bytes written to file $png"
while :; do sleep 0.1; done`,
			);
			const session = await new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: script } }).open(
				deck,
				size,
			);
			const started = Date.now();
			try {
				const png = await session.capture();
				expect([...png.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
			} finally {
				await session.close();
			}
			// Resolved only once the SIGKILL landed, not straight after the SIGTERM.
			expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
			const leader = Number(readFileSync(join(work, "leader.pid"), "utf8"));
			expect(alive(leader)).toBe(false);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 15_000);

	test("the probe waits for Chrome to exit before deleting its temp dir", async () => {
		const work = mkdtempSync(join(tmpdir(), "render-probe-"));
		try {
			// On SIGTERM it keeps writing into its profile for a moment, as a dying Chrome can.
			const script = fakeChrome(
				work,
				`trap 'sleep 0.3; mkdir -p "$prof/late"; : > "$prof/late/x"; exit 0' TERM
echo "4 bytes written to file $png"
while :; do sleep 0.05 & wait $!; done`,
			);
			const r = await new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: script } }).available();
			expect(r).toEqual({ ok: true });
			const profile = readFileSync(join(work, "profile.txt"), "utf8");
			expect(profile).toContain("8gent-render-probe-");
			await Bun.sleep(700);
			expect(existsSync(profile)).toBe(false);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	}, 15_000);

	test("a session dir is removed when the caller throws before close()", () => {
		const work = mkdtempSync(join(tmpdir(), "render-throw-"));
		try {
			const deck = join(work, "d.html");
			writeFileSync(deck, "<html></html>");
			const main = join(work, "caller.ts");
			writeFileSync(
				main,
				`import { ChromeHeadlessBackend } from ${JSON.stringify(join(import.meta.dir, "chrome.ts"))};
const backend = new ChromeHeadlessBackend({ env: { EIGHT_CHROME_PATH: "/bin/sh" } });
const session = await backend.open(${JSON.stringify(deck)}, { width: 1, height: 1 });
console.log((session as unknown as { workDir: string }).workDir);
throw new Error("caller failed before close");
`,
			);
			const run = Bun.spawnSync([process.execPath, main], { stdout: "pipe", stderr: "pipe" });
			expect(run.exitCode).not.toBe(0);
			expect(run.stderr.toString()).toContain("caller failed before close");
			const dir = run.stdout.toString().trim();
			expect(dir).toContain("8gent-render-");
			expect(existsSync(dir)).toBe(false);
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
