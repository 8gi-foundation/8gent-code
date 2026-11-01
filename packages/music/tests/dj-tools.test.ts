/**
 * The DJ's pinned tools: fetched on first use, verified, ask once with default No (DJ zero-install).
 *
 * Nothing touches the network or the real home: fetch is a fixture release, home is a temp dir,
 * and the pins are a fixture manifest that lists the targets a real release would.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DJ, setDjProvision, setDjSpawn, setDjTools, setDjWhich } from "../dj";
import {
	type DjToolPins,
	djAssetName,
	djTarget,
	downloadPlan,
	fetchDjTool,
	managedDjTool,
} from "../dj-tools";

const VERSION = "9.9.9";
const PINS: DjToolPins = {
	asset: "dj-{tool}-{target}{ext}",
	targets: {
		mpv: { "linux-x64": { mb: 12 }, "win32-x64": { mb: 14 } },
		"yt-dlp": { "linux-x64": { mb: 40 } },
		ffmpeg: { "linux-x64": { mb: 9 } },
	},
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const bytesOf = (name: string) => new TextEncoder().encode(`binary:${name}`);

/** A fixture release: SHA256SUMS plus the assets, served at the release URLs. Records every URL asked for. */
function release(opts: { skip?: string[]; corrupt?: string[] } = {}) {
	const urls: string[] = [];
	const assets = [
		"dj-mpv-linux-x64",
		"dj-yt-dlp-linux-x64",
		"dj-ffmpeg-linux-x64",
		"dj-mpv-win32-x64.exe",
	];
	const sums = assets
		.filter((a) => !opts.skip?.includes(a))
		.map((a) => `${sha(bytesOf(a))}  ${a}`)
		.join("\n");
	const base = `https://github.com/8gi-foundation/8gent-code/releases/download/v${VERSION}/`;
	const fetchImpl = (async (url: string) => {
		urls.push(url);
		const name = url.slice(base.length);
		const ok = (b: Uint8Array) => ({ ok: true, status: 200, arrayBuffer: async () => b.buffer });
		if (name === "SHA256SUMS") return ok(new TextEncoder().encode(sums));
		if (assets.includes(name))
			return ok(
				opts.corrupt?.includes(name) ? new TextEncoder().encode("tampered") : bytesOf(name),
			);
		return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
	}) as never;
	return { fetchImpl, urls };
}

let home: string;
const env = () => ({ HOME: home, EIGHT_HOME: home });
const deps = (r = release(), runs: (b: string) => boolean = () => true) => ({
	env: env(),
	platform: "linux",
	arch: "x64",
	version: VERSION,
	pins: PINS,
	fetchImpl: r.fetchImpl,
	runs,
});

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "dj-tools-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	setDjProvision();
	setDjWhich();
	setDjTools();
	setDjSpawn();
});

describe("targets and names", () => {
	test("targets cover mac, linux, windows x64 and the phone", () => {
		expect(djTarget("darwin", "arm64", {})).toBe("darwin-arm64");
		expect(djTarget("darwin", "x64", {})).toBe("darwin-x64");
		expect(djTarget("linux", "x64", {})).toBe("linux-x64");
		expect(djTarget("linux", "arm64", {})).toBe("linux-arm64");
		expect(djTarget("win32", "x64", {})).toBe("win32-x64");
		expect(djTarget("win32", "arm64", {})).toBeNull();
		expect(djTarget("linux", "arm64", { TERMUX_VERSION: "0.118" })).toBe("android-arm64");
		expect(djTarget("freebsd", "x64", {})).toBeNull();
	});

	test("asset names follow the pins' rule; Windows gets .exe", () => {
		expect(djAssetName("mpv", "linux-x64", PINS.asset)).toBe("dj-mpv-linux-x64");
		expect(djAssetName("yt-dlp", "win32-x64", PINS.asset)).toBe("dj-yt-dlp-win32-x64.exe");
	});

	test("tools land in ~/.8gent/bin/dj", () => {
		expect(managedDjTool("mpv", { EIGHT_HOME: "/h" }, "linux")).toBe("/h/.8gent/bin/dj/mpv");
		expect(managedDjTool("mpv", { EIGHT_HOME: "/h" }, "win32")).toMatch(/dj[\\/]mpv\.exe$/);
	});

	test("the shipped pins list no build yet, so nothing is offered until a release carries one", () => {
		expect(
			downloadPlan(["mpv", "yt-dlp", "ffmpeg"], { platform: "linux", arch: "x64", env: {} }),
		).toBeNull();
	});

	test("a plan names only tools with a build here, and their size", () => {
		const p = downloadPlan(["mpv", "yt-dlp", "ffmpeg"], {
			platform: "win32",
			arch: "x64",
			env: {},
			pins: PINS,
		});
		expect(p).toEqual({ target: "win32-x64", tools: ["mpv"], mb: 14 });
		expect(
			downloadPlan(["mpv"], { platform: "darwin", arch: "arm64", env: {}, pins: PINS }),
		).toBeNull();
	});
});

describe("fetchDjTool", () => {
	test("verifies against the release's SHA256SUMS, runs it once, renames it into place", async () => {
		const r = release();
		const ran: string[] = [];
		const got = await fetchDjTool(
			"mpv",
			deps(r, (b) => {
				ran.push(b);
				return true;
			}),
		);
		const dest = managedDjTool("mpv", env(), "linux");
		expect(got).toEqual({ ok: true, bin: dest });
		expect(readFileSync(dest, "utf-8")).toBe("binary:dj-mpv-linux-x64");
		expect(statSync(dest).mode & 0o111).not.toBe(0);
		expect(ran).toHaveLength(1);
		expect(ran[0]).not.toBe(dest); // smoke-run in the staging name, before the rename
		expect(r.urls).toEqual([
			`https://github.com/8gi-foundation/8gent-code/releases/download/v${VERSION}/SHA256SUMS`,
			`https://github.com/8gi-foundation/8gent-code/releases/download/v${VERSION}/dj-mpv-linux-x64`,
		]);
		expect(readdirSync(dirname(dest))).toEqual(["mpv"]);
	});

	test("a file that does not match SHA256SUMS is never installed or run", async () => {
		let ran = false;
		const got = await fetchDjTool(
			"mpv",
			deps(release({ corrupt: ["dj-mpv-linux-x64"] }), () => {
				ran = true;
				return true;
			}),
		);
		expect(got.ok).toBe(false);
		expect(got.ok === false && got.why).toContain("does not match");
		expect(ran).toBe(false);
		expect(existsSync(managedDjTool("mpv", env(), "linux"))).toBe(false);
		expect(existsSync(join(home, ".8gent", "bin", "dj"))).toBe(false); // refused before anything was written
	});

	test("an asset the release does not list is a clear failure", async () => {
		const got = await fetchDjTool("mpv", deps(release({ skip: ["dj-mpv-linux-x64"] })));
		expect(got).toEqual({
			ok: false,
			why: `v${VERSION} has no dj-mpv-linux-x64 in its SHA256SUMS`,
		});
	});

	test("verified but would not run: nothing is left behind", async () => {
		const got = await fetchDjTool(
			"mpv",
			deps(release(), () => false),
		);
		expect(got.ok === false && got.why).toContain("would not run");
		expect(readdirSync(join(home, ".8gent", "bin", "dj"))).toEqual([]);
	});

	test("no pinned build for this target: no request is made", async () => {
		const r = release();
		const got = await fetchDjTool("yt-dlp", { ...deps(r), platform: "win32" });
		expect(got.ok).toBe(false);
		expect(r.urls).toEqual([]);
	});
});

describe("/dj ensureTools through the pinned download", () => {
	function io(answer: boolean) {
		const asked: Array<{ q: string; defaultYes?: boolean }> = [];
		const said: string[] = [];
		const progress: string[] = [];
		return {
			asked,
			said,
			progress,
			io: {
				ask: async (q: string, defaultYes?: boolean) => {
					asked.push({ q, defaultYes });
					return answer;
				},
				say: (l: string) => said.push(l),
				progress: (l: string) => progress.push(l),
				plat: "linux" as NodeJS.Platform,
			},
		};
	}
	const setup = (r = release(), runs: (b: string) => boolean = () => true) => {
		setDjWhich(() => null); // nothing on PATH
		setDjTools();
		setDjProvision(deps(r, runs));
	};

	test("asks once, defaulting to No, and touches no network before the yes", async () => {
		const r = release();
		setup(r);
		const h = io(false);
		expect(await new DJ().ensureTools(h.io)).toBe("declined");
		expect(h.asked).toHaveLength(1);
		expect(h.asked[0].defaultYes).toBe(false);
		expect(h.asked[0].q).toContain("mpv, yt-dlp, ffmpeg");
		expect(h.asked[0].q).toContain("about 61 MB");
		expect(h.asked[0].q).toContain("Enter = no");
		expect(r.urls).toEqual([]);
		expect(h.said.at(-1)).toContain("Run: sudo apt install mpv yt-dlp ffmpeg");
	});

	test("yes: fetches each tool, and the DJ then finds its own copies", async () => {
		const r = release();
		setup(r);
		const h = io(true);
		const dj = new DJ();
		expect(await dj.ensureTools(h.io)).toBe("downloaded");
		expect(h.progress).toEqual([
			"Downloading mpv (1 of 3)",
			"Downloading yt-dlp (2 of 3)",
			"Downloading ffmpeg (3 of 3)",
		]);
		expect(dj.missingTools()).toEqual([]);
		expect(dj.doctor().mpv).toBe(true);
	});

	test("a tool already on PATH is used and nothing is offered for it", async () => {
		setup();
		setDjWhich((c) => (c === "mpv" ? "/usr/bin/mpv" : null));
		const h = io(true);
		await new DJ().ensureTools(h.io);
		expect(h.asked[0].q).toStartWith("yt-dlp, ffmpeg are not installed");
	});

	test("a tampered download fails, names why, and leaves the tools missing", async () => {
		setup(release({ corrupt: ["dj-yt-dlp-linux-x64"] }));
		const h = io(true);
		const dj = new DJ();
		expect(await dj.ensureTools(h.io)).toBe("failed");
		expect(h.said.at(-1)).toContain("yt-dlp: dj-yt-dlp-linux-x64 does not match");
		expect(dj.missingTools()).toEqual(["yt-dlp"]);
	});

	test("nothing missing: no question", async () => {
		setup();
		setDjWhich((c) => `/usr/bin/${c}`);
		const h = io(true);
		expect(await new DJ().ensureTools(h.io)).toBe("none");
		expect(h.asked).toEqual([]);
	});
});
