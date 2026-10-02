/**
 * 8gent Browser backend (#3346 PR 3), tested against a mock control server on
 * loopback that follows the PR #50 protocol: no Origin header, auth as the first
 * frame, then { id, cmd, args } -> { id, ok, result | error }.
 *
 * The real-browser path runs only with EIGHT_RENDER_E2E=1 (after the #50 build
 * is installed on the Mac).
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { selectBackend } from "./backend";
import { DECK_TIMELINE, DECK_TIMELINE_SHIM, EightBrowserBackend } from "./eight-browser";

const TOKEN = "tok-3f1c9a7e-secret-never-printed";
// A real 1x1 PNG, so capture() can check the signature.
const PNG_B64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const FORBIDDEN_CMD = ["tabs", "list"].join(".");

interface Frame {
	id?: number;
	cmd?: string;
	type?: string;
	token?: string;
	args?: Record<string, unknown>;
}

interface MockOptions {
	timelines?: string[];
	failOn?: string;
	/** A hostile or buggy server that echoes the token in an error. */
	leakToken?: boolean;
	silentOn?: string;
}

/** Mirrors control-server.ts: refuse an Origin header, gate on the first frame. */
function mockServer(opts: MockOptions = {}) {
	const frames: Frame[] = [];
	const origins: (string | null)[] = [];
	const server = Bun.serve<{ authed: boolean }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			origins.push(req.headers.get("origin"));
			if (req.headers.get("origin") !== null) return new Response("forbidden", { status: 403 });
			if (srv.upgrade(req, { data: { authed: false } })) return undefined;
			return new Response("no", { status: 400 });
		},
		websocket: {
			message(ws, raw) {
				const msg = JSON.parse(String(raw)) as Frame;
				frames.push(msg);
				if (!ws.data.authed) {
					if (msg.type === "auth" && msg.token === TOKEN) {
						ws.data.authed = true;
						ws.send(JSON.stringify({ type: "auth_ok" }));
					} else {
						ws.send(JSON.stringify({ type: "error", error: "unauthorized" }));
						ws.close(4401, "unauthorized");
					}
					return;
				}
				const { id, cmd } = msg;
				if (cmd === opts.silentOn) return;
				if (cmd === opts.failOn) {
					ws.send(
						JSON.stringify({
							id,
							ok: false,
							error: `render: ${cmd} failed in mock${opts.leakToken ? ` ${TOKEN}` : ""}`,
						}),
					);
					return;
				}
				const result =
					cmd === "render.open"
						? { renderId: "r-1", timelines: opts.timelines ?? [DECK_TIMELINE] }
						: cmd === "render.seek"
							? { t: msg.args?.t, duration: 3 }
							: cmd === "render.capture"
								? { png: PNG_B64, bytes: 70, width: 1, height: 1 }
								: cmd === "render.close"
									? { closed: true }
									: null;
				if (result === null)
					ws.send(JSON.stringify({ id, ok: false, error: `unknown cmd: ${cmd}` }));
				else ws.send(JSON.stringify({ id, ok: true, result }));
			},
		},
	});
	return { server, frames, origins, port: server.port as number };
}

let work: string;
let tokenPath: string;
let roots: string;
const servers: { stop(force?: boolean): void }[] = [];

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "8gent-eb-test-"));
	tokenPath = join(work, "browser-control.token");
	writeFileSync(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	roots = join(work, "renders");
	mkdirSync(join(roots, "deck-abc"), { recursive: true });
	writeFileSync(join(roots, "deck-abc", "deck.html"), "<!doctype html><p>deck</p>");
});

afterEach(() => {
	while (servers.length) servers.pop()?.stop(true);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

function setup(
	opts: MockOptions = {},
	extra: Partial<ConstructorParameters<typeof EightBrowserBackend>[0]> = {},
) {
	const m = mockServer(opts);
	servers.push(m.server);
	const backend = new EightBrowserBackend({
		port: m.port,
		tokenPath,
		rendersRoot: roots,
		callTimeoutMs: 1000,
		...extra,
	});
	return { ...m, backend };
}

const deck = () => join(roots, "deck-abc", "deck.html");
const cmds = (frames: Frame[]) => frames.map((f) => f.cmd ?? f.type);

describe("8gent Browser backend: protocol", () => {
	test("auth is the first frame and carries the token from the file, trimmed", async () => {
		const { backend, frames, origins } = setup();
		const s = await backend.open(deck(), { width: 1280, height: 720 });
		await s.close();
		expect(frames[0]).toEqual({ type: "auth", token: TOKEN });
		// The real server refuses any handshake with an Origin header; Bun's client sends none.
		expect(origins.every((o) => o === null)).toBe(true);
	});

	test("one render.open per deck, N seeks on the deck timeline, captures, one close", async () => {
		const { backend, frames } = setup();
		const s = await backend.open(deck(), { width: 1280, height: 720 });
		const shots: Uint8Array[] = [];
		for (let k = 0; k < 3; k++) {
			await s.show(k);
			shots.push(await s.capture());
		}
		await s.close();
		await s.close(); // idempotent
		expect(cmds(frames)).toEqual([
			"auth",
			"render.open",
			"render.seek",
			"render.capture",
			"render.seek",
			"render.capture",
			"render.seek",
			"render.capture",
			"render.close",
		]);
		const open = frames[1].args ?? {};
		expect(open).toEqual({ url: realpathSync(deck()), width: 1280, height: 720 });
		expect(frames[2].args).toEqual({ renderId: "r-1", composition: DECK_TIMELINE, t: 0 });
		expect(frames[6].args?.t).toBe(2);
		expect(frames[8].args).toEqual({ renderId: "r-1" });
		expect(Buffer.from(shots[0]).toString("base64")).toBe(PNG_B64);
	});

	test("a document without the deck timeline is refused, and the render is still closed", async () => {
		const { backend, frames } = setup({ timelines: [] });
		await expect(backend.open(deck(), { width: 320, height: 180 })).rejects.toThrow(
			/no window.__timelines.deck/,
		);
		expect(cmds(frames)).toEqual(["auth", "render.open", "render.close"]);
	});

	test("a failing step surfaces the server error; close still runs", async () => {
		const { backend, frames } = setup({ failOn: "render.capture" });
		const s = await backend.open(deck(), { width: 320, height: 180 });
		await s.show(0);
		await expect(s.capture()).rejects.toThrow(/render.capture failed in mock/);
		await s.close();
		expect(cmds(frames).at(-1)).toBe("render.close");
	});

	test("a call the server never answers times out instead of hanging", async () => {
		const { backend } = setup({ silentOn: "render.seek" }, { callTimeoutMs: 150 });
		const s = await backend.open(deck(), { width: 320, height: 180 });
		await expect(s.show(1)).rejects.toThrow(/render.seek timed out/);
		await s.close();
	});

	test("a closed session refuses further work", async () => {
		const { backend } = setup();
		const s = await backend.open(deck(), { width: 320, height: 180 });
		await s.close();
		await expect(s.show(0)).rejects.toThrow(/closed/);
		await expect(s.capture()).rejects.toThrow(/closed/);
	});
});

describe("8gent Browser backend: inputs", () => {
	test("a document outside the renders root is refused before the browser sees it", async () => {
		const { backend, frames } = setup();
		const outside = join(work, "outside.html");
		writeFileSync(outside, "<p>x</p>");
		await expect(backend.open(outside, { width: 320, height: 180 })).rejects.toThrow(
			/under .*renders/,
		);
		expect(frames).toEqual([]);
	});

	test("a dot segment under the root is refused (the browser never serves one)", async () => {
		const { backend, frames } = setup();
		mkdirSync(join(roots, ".hidden"), { recursive: true });
		const dotted = join(roots, ".hidden", "deck.html");
		writeFileSync(dotted, "<p>x</p>");
		await expect(backend.open(dotted, { width: 320, height: 180 })).rejects.toThrow(/dot/);
		expect(frames).toEqual([]);
	});

	test("the deck timeline shim registers the id the backend seeks", () => {
		expect(DECK_TIMELINE).toBe("deck");
		expect(DECK_TIMELINE_SHIM).toContain("__timelines.deck");
		expect(DECK_TIMELINE_SHIM).toContain("Math.round(t)");
	});
});

describe("8gent Browser backend: available()", () => {
	test("probes with auth, render.open of a tiny page under the root, render.close, and cleans up", async () => {
		const { backend, frames } = setup({ timelines: [] });
		expect(await backend.available()).toEqual({ ok: true });
		expect(cmds(frames)).toEqual(["auth", "render.open", "render.close"]);
		expect(cmds(frames)).not.toContain(FORBIDDEN_CMD);
		const url = String(frames[1].args?.url);
		expect(url.startsWith(roots) || url.startsWith(realpathSync(roots))).toBe(true);
		expect(Number(frames[1].args?.width)).toBeGreaterThanOrEqual(16); // server minimum
		expect(existsSync(url)).toBe(false);
	});

	test("a wrong token is an honest reason that never contains either token", async () => {
		const m = mockServer();
		servers.push(m.server);
		const wrong = join(work, "wrong.token");
		writeFileSync(wrong, "tok-wrong-also-secret");
		const backend = new EightBrowserBackend({ port: m.port, tokenPath: wrong, rendersRoot: roots });
		const r = await backend.available();
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/auth refused: unauthorized/);
		expect(r.reason).not.toContain("tok-wrong-also-secret");
		expect(r.reason).not.toContain(TOKEN);
	});

	test("no token file says where it looked and what to do", async () => {
		const backend = new EightBrowserBackend({
			port: 1,
			tokenPath: join(work, "nope.token"),
			rendersRoot: roots,
		});
		const r = await backend.available();
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/no control token at .*nope\.token/);
	});

	test("nothing listening is an honest reason, not a hang", async () => {
		const m = mockServer();
		const port = m.port;
		m.server.stop(true);
		const backend = new EightBrowserBackend({
			port,
			tokenPath,
			rendersRoot: roots,
			connectTimeoutMs: 1000,
		});
		const r = await backend.available();
		expect(r.ok).toBe(false);
		expect(r.reason).toMatch(/cannot reach ws:\/\/127\.0\.0\.1/);
	});

	test("the token never reaches stdout or stderr on any path", async () => {
		const seen: string[] = [];
		const orig = { log: console.log, error: console.error, warn: console.warn };
		const grab = (...a: unknown[]) => seen.push(a.map(String).join(" "));
		console.log = grab;
		console.error = grab;
		console.warn = grab;
		try {
			const { backend } = setup({ failOn: "render.seek", leakToken: true });
			await backend.available();
			const s = await backend.open(deck(), { width: 320, height: 180 });
			await s.show(0).catch((e: Error) => seen.push(e.message));
			await s.close();
		} finally {
			Object.assign(console, orig);
		}
		expect(seen.join("\n")).toContain("failed in mock [token]");
		expect(seen.join("\n")).not.toContain(TOKEN);
	});

	test("selectBackend picks it first when the control server answers", async () => {
		const { backend } = setup({ timelines: [] });
		const chrome = {
			name: "chrome-headless" as const,
			available: async () => ({ ok: true }),
			open: async () => {
				throw new Error("not used");
			},
		};
		expect((await selectBackend([chrome, backend], {})).name).toBe("8gent-browser");
	});
});

// The real path: James's Mac with the PR #50 build installed and running.
describe.if(process.env.EIGHT_RENDER_E2E === "1")("8gent Browser backend: real browser", () => {
	test("three slides render as three distinct PNGs at the requested size", async () => {
		const backend = new EightBrowserBackend();
		const probe = await backend.available();
		expect(probe).toEqual({ ok: true });
		const dir = join(homedir(), ".8gent", "renders", `e2e-3346-${process.pid}`);
		mkdirSync(dir, { recursive: true });
		const html = join(dir, "deck.html");
		const colors = ["#c0392b", "#27ae60", "#2980b9"];
		writeFileSync(
			html,
			`<!doctype html><html><head><style>html,body{margin:0}.slide{display:none;width:100vw;height:100vh}.slide.active{display:block}</style></head><body>${colors
				.map((c, i) => `<div class="slide" data-slide="${i}" style="background:${c}"></div>`)
				.join(
					"",
				)}<script>(function(){function show(){var m=(location.hash.match(/slide=(\\d+)/)||[])[1];if(m==null)return;document.querySelectorAll('.slide').forEach(function(el){el.classList.toggle('active',el.getAttribute('data-slide')===m)})}window.addEventListener('hashchange',show)})();</script>${DECK_TIMELINE_SHIM}</body></html>`,
		);
		const s = await backend.open(html, { width: 320, height: 180 });
		const shots: Buffer[] = [];
		try {
			for (let k = 0; k < 3; k++) {
				await s.show(k);
				shots.push(Buffer.from(await s.capture()));
			}
		} finally {
			await s.close();
			rmSync(dir, { recursive: true, force: true });
		}
		for (const png of shots) {
			expect(png.readUInt32BE(16)).toBe(320);
			expect(png.readUInt32BE(20)).toBe(180);
		}
		expect(new Set(shots.map((b) => b.toString("base64"))).size).toBe(3);
	}, 60_000);
});
