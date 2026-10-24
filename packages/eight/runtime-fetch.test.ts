import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JUDGE_MODEL } from "../decide/judge-model";
import { managedLlamaServer } from "./local-runtime";
import {
	JUDGE_GGUF,
	JUDGE_MODELS,
	assetName,
	ensureLlamaServer,
	fetchJudgeModel,
	fetchLlamaServer,
	findLlamaServer,
	judgeModelFor,
	judgeModelPath,
	judgeModelPresent,
	judgeRepo,
	releaseUrl,
	runtimeTarget,
} from "./runtime-fetch";
import pins from "./runtime-pins.json";
import type { FetchLike } from "./self-update";

const roots: string[] = [];
const home = () => {
	const d = mkdtempSync(join(tmpdir(), "runtime-fetch-"));
	roots.push(d);
	return d;
};
afterAll(() => {
	for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("asset selection per platform and arch", () => {
	test("every release target is selected by exactly one platform and arch", () => {
		expect(runtimeTarget("linux", "x64", {})).toBe("linux-x64");
		expect(runtimeTarget("linux", "arm64", {})).toBe("linux-arm64");
		expect(runtimeTarget("darwin", "arm64", {})).toBe("darwin-arm64");
		expect(runtimeTarget("darwin", "x64", {})).toBe("darwin-x64");
		// Termux reports linux or android; either way the Termux env wins.
		expect(runtimeTarget("android", "arm64", {})).toBe("android-arm64");
		expect(runtimeTarget("linux", "arm64", { TERMUX_VERSION: "0.118" })).toBe("android-arm64");
		expect(runtimeTarget("linux", "arm64", { PREFIX: "/data/data/com.termux/files/usr" })).toBe(
			"android-arm64",
		);
		const all = [
			runtimeTarget("linux", "x64", {}),
			runtimeTarget("linux", "arm64", {}),
			runtimeTarget("darwin", "arm64", {}),
			runtimeTarget("darwin", "x64", {}),
			runtimeTarget("android", "arm64", {}),
		];
		expect([...all].sort()).toEqual([...pins.targets].sort());
	});

	test("no build: Windows, 32-bit, android on x64, unknown", () => {
		expect(runtimeTarget("win32", "x64", {})).toBeNull();
		expect(runtimeTarget("linux", "ia32", {})).toBeNull();
		expect(runtimeTarget("linux", "x64", { TERMUX_VERSION: "1" })).toBeNull();
		expect(runtimeTarget("freebsd", "x64", {})).toBeNull();
	});

	test("asset names follow the pins and the release URL is 8gent's own release for the version", () => {
		expect(assetName("llama-server", "android-arm64")).toBe("llama-server-android-arm64");
		expect(assetName("whisper-cli", "darwin-x64")).toBe("whisper-cli-darwin-x64");
		expect(releaseUrl("0.20.26", "SHA256SUMS")).toBe(
			"https://github.com/8gi-foundation/8gent-code/releases/download/v0.20.26/SHA256SUMS",
		);
	});
});

/** A fake release: SHA256SUMS and the asset, served through the self-update fetch shape. */
function release(
	over: { bytes?: string; sums?: string | null; serveBytes?: string; status?: number } = {},
) {
	const good = over.bytes ?? "#!/bin/sh\necho llama-server fake\n";
	const asset = "llama-server-linux-x64";
	const sums = over.sums === undefined ? `${sha(good)}  ${asset}\n` : over.sums;
	const urls: string[] = [];
	const fetchImpl: FetchLike = async (url) => {
		urls.push(url);
		const mk = (body: string, status = 200) => ({
			ok: status === 200,
			status,
			headers: { get: () => null },
			json: async () => ({}),
			text: async () => body,
			arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
		});
		if (url.endsWith("/SHA256SUMS")) return sums === null ? mk("", 404) : mk(sums);
		if (url.endsWith(`/${asset}`)) return mk(over.serveBytes ?? good, over.status ?? 200);
		return mk("", 404);
	};
	return { fetchImpl, urls, good, asset };
}

describe("fetchLlamaServer: verify, then install atomically", () => {
	const base = (h: string) => ({
		env: { EIGHT_HOME: h } as Record<string, string>,
		platform: "linux",
		arch: "x64",
		version: "0.20.26",
	});

	test("a good file is checksummed against SHA256SUMS, run, and installed 0755 with no leftovers", async () => {
		const h = home();
		const rel = release();
		const ran: string[] = [];
		const r = await fetchLlamaServer({
			...base(h),
			fetchImpl: rel.fetchImpl,
			runs: (bin) => {
				ran.push(bin);
				// It is run in its staging name, before it is renamed into place.
				expect(existsSync(managedLlamaServer(base(h).env))).toBe(false);
				return true;
			},
		});
		const dest = managedLlamaServer(base(h).env);
		expect(r).toEqual({ ok: true, bin: dest });
		expect(readFileSync(dest, "utf-8")).toBe(rel.good);
		expect(statSync(dest).mode & 0o777).toBe(0o755);
		expect(readdirSync(dirname(dest))).toEqual(["llama-server"]);
		expect(ran.length).toBe(1);
		expect(rel.urls).toEqual([
			releaseUrl("0.20.26", "SHA256SUMS"),
			releaseUrl("0.20.26", "llama-server-linux-x64"),
		]);
	});

	test("a tampered file is refused: nothing installed, nothing left behind", async () => {
		const h = home();
		const rel = release({ serveBytes: "#!/bin/sh\necho evil\n" });
		const r = await fetchLlamaServer({ ...base(h), fetchImpl: rel.fetchImpl, runs: () => true });
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("does not match");
		const dir = dirname(managedLlamaServer(base(h).env));
		expect(existsSync(managedLlamaServer(base(h).env))).toBe(false);
		expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
	});

	test("a tampered file never replaces a good install", async () => {
		const h = home();
		const dest = managedLlamaServer(base(h).env);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, "GOOD");
		chmodSync(dest, 0o755);
		const rel = release({ serveBytes: "evil" });
		const r = await fetchLlamaServer({ ...base(h), fetchImpl: rel.fetchImpl, runs: () => true });
		expect(r.ok).toBe(false);
		expect(readFileSync(dest, "utf-8")).toBe("GOOD");
		expect(readdirSync(dirname(dest))).toEqual(["llama-server"]);
	});

	test("no line in SHA256SUMS, no SHA256SUMS, an asset that 404s, or a build that will not run: not installed", async () => {
		for (const [over, runs] of [
			[{ sums: `${"0".repeat(64)}  something-else\n` }, true],
			[{ sums: null }, true],
			[{ status: 404 }, true],
			[{}, false],
		] as const) {
			const h = home();
			const r = await fetchLlamaServer({
				...base(h),
				fetchImpl: release(over).fetchImpl,
				runs: () => runs,
			});
			expect(r.ok).toBe(false);
			expect(existsSync(managedLlamaServer(base(h).env))).toBe(false);
		}
	});

	test("a release signing key means an unsigned SHA256SUMS is refused", async () => {
		const h = home();
		const r = await fetchLlamaServer({
			...base(h),
			fetchImpl: release().fetchImpl,
			runs: () => true,
			signingKey: "RWQfake",
		});
		expect(r.ok).toBe(false);
		expect(existsSync(managedLlamaServer(base(h).env))).toBe(false);
	});

	test("a platform with no build says so and fetches nothing", async () => {
		const h = home();
		const rel = release();
		const r = await fetchLlamaServer({
			env: { EIGHT_HOME: h },
			platform: "win32",
			arch: "x64",
			fetchImpl: rel.fetchImpl,
		});
		expect(r.ok).toBe(false);
		expect(rel.urls).toEqual([]);
	});
});

describe("fallback order: managed, then 8gent's release, then a system llama-server", () => {
	const noFetch = async () => {
		throw new Error("must not fetch");
	};

	test("an installed one is used, nothing fetched, a system one ignored", async () => {
		const r = await ensureLlamaServer({
			env: { EIGHT_HOME: "/h" },
			exists: () => true,
			find: () => "/usr/bin/llama-server",
			fetchBinary: noFetch,
		});
		expect(r).toEqual({ ok: true, bin: "/h/.8gent/bin/llama-server", source: "managed" });
	});

	test("not installed: 8gent's release is the default even when a system one exists", async () => {
		const r = await ensureLlamaServer({
			env: { EIGHT_HOME: "/h" },
			exists: () => false,
			find: () => "/usr/bin/llama-server",
			fetchBinary: async () => ({ ok: true, bin: "/h/.8gent/bin/llama-server" }),
		});
		expect(r).toMatchObject({ ok: true, source: "fetched" });
	});

	test("the release cannot be had: the system one is the fallback, with the reason", async () => {
		const r = await ensureLlamaServer({
			env: { EIGHT_HOME: "/h" },
			exists: () => false,
			find: () => "/usr/bin/llama-server",
			fetchBinary: async () => ({ ok: false, why: "offline" }),
		});
		expect(r).toEqual({
			ok: true,
			bin: "/usr/bin/llama-server",
			source: "system",
			note: "offline",
		});
	});

	test("nothing at all: the reason", async () => {
		const r = await ensureLlamaServer({
			env: { EIGHT_HOME: "/h" },
			exists: () => false,
			find: () => null,
			fetchBinary: async () => ({ ok: false, why: "offline" }),
		});
		expect(r).toEqual({ ok: false, why: "offline" });
	});

	test("findLlamaServer prefers the installed one", () => {
		expect(
			findLlamaServer(
				{ EIGHT_HOME: "/h" },
				() => true,
				() => "/sys",
			)?.source,
		).toBe("managed");
		expect(
			findLlamaServer(
				{ EIGHT_HOME: "/h" },
				() => false,
				() => "/sys",
			)?.source,
		).toBe("system");
		expect(
			findLlamaServer(
				{ EIGHT_HOME: "/h" },
				() => false,
				() => null,
			),
		).toBeNull();
	});
});

describe("judge model: pinned, streamed, verified", () => {
	const content = new TextEncoder().encode("GGUF-model-bytes-".repeat(50));
	const pin = { sha256: sha(content), bytes: content.byteLength };
	const model = "hf.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF:latest";

	function hf(over: { body?: Uint8Array; tree?: unknown; redirectTo?: string } = {}) {
		const urls: string[] = [];
		const body = over.body ?? content;
		const tree = over.tree ?? [
			{ path: "README.md", lfs: undefined },
			{ path: "other.gguf", lfs: { oid: "f".repeat(64) } },
			{ path: "the-judge.gguf", lfs: { oid: pin.sha256 } },
		];
		const fetchImpl = async (url: string) => {
			urls.push(url);
			if (over.redirectTo && url.includes("/resolve/"))
				return new Response(null, { status: 302, headers: { location: over.redirectTo } });
			if (url.includes("/api/models/")) return Response.json(tree);
			if (url.includes("/resolve/")) {
				// Two chunks, so the hash and the size are checked across the stream.
				const half = Math.floor(body.byteLength / 2);
				return new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(body.slice(0, half));
							c.enqueue(body.slice(half));
							c.close();
						},
					}),
				);
			}
			return new Response("no", { status: 404 });
		};
		return { fetchImpl, urls };
	}

	test("the file whose LFS hash is the pin is downloaded, hashed, and renamed into place at 0600", async () => {
		const h = home();
		const env = { EIGHT_HOME: h };
		const pcts: number[] = [];
		const f = hf();
		const r = await fetchJudgeModel({
			env,
			pin,
			model,
			fetchImpl: f.fetchImpl,
			onPercent: (p) => pcts.push(p),
		});
		const dest = judgeModelPath(env, pin);
		expect(r).toEqual({ ok: true, path: dest });
		expect(sha(readFileSync(dest))).toBe(pin.sha256);
		expect(statSync(dest).mode & 0o777).toBe(0o600);
		expect(readdirSync(dirname(dest))).toEqual([`${pin.sha256.slice(0, 12)}.gguf`]);
		expect(pcts.at(-1)).toBe(100);
		expect(f.urls).toEqual([
			"https://huggingface.co/api/models/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF/tree/main",
			"https://huggingface.co/AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF/resolve/main/the-judge.gguf",
		]);
		expect(judgeModelPresent(env, pin)).toBe(true);
		// Present means no second download.
		const again = hf();
		await fetchJudgeModel({ env, pin, model, fetchImpl: again.fetchImpl });
		expect(again.urls).toEqual([]);
	});

	test("same size, different bytes: refused and deleted", async () => {
		const h = home();
		const env = { EIGHT_HOME: h };
		const tampered = content.slice();
		tampered[7] ^= 0xff;
		const r = await fetchJudgeModel({
			env,
			pin,
			model,
			fetchImpl: hf({ body: tampered }).fetchImpl,
		});
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.why).toContain("pinned checksum");
		expect(existsSync(judgeModelPath(env, pin))).toBe(false);
		expect(readdirSync(dirname(judgeModelPath(env, pin)))).toEqual([]);
	});

	test("short and oversized downloads are refused and leave nothing", async () => {
		for (const body of [
			content.slice(0, content.byteLength - 1),
			new Uint8Array([...content, 1]),
		]) {
			const h = home();
			const env = { EIGHT_HOME: h };
			const r = await fetchJudgeModel({ env, pin, model, fetchImpl: hf({ body }).fetchImpl });
			expect(r.ok).toBe(false);
			expect(existsSync(judgeModelPath(env, pin))).toBe(false);
			expect(readdirSync(dirname(judgeModelPath(env, pin)))).toEqual([]);
		}
	});

	test("a repo with no file of the pinned hash, and a redirect off Hugging Face, are refused", async () => {
		const h = home();
		const none = await fetchJudgeModel({
			env: { EIGHT_HOME: h },
			pin,
			model,
			fetchImpl: hf({ tree: [{ path: "x.gguf", lfs: { oid: "a".repeat(64) } }] }).fetchImpl,
		});
		expect(none.ok).toBe(false);
		const off = await fetchJudgeModel({
			env: { EIGHT_HOME: home() },
			pin,
			model,
			fetchImpl: hf({ redirectTo: "https://evil.example/model.gguf" }).fetchImpl,
		});
		expect(off.ok).toBe(false);
		if (!off.ok) expect(off.why).toContain("refusing");
		const plain = await fetchJudgeModel({
			env: { EIGHT_HOME: home() },
			pin,
			model,
			fetchImpl: hf({ redirectTo: "http://cdn-lfs.hf.co/model.gguf" }).fetchImpl,
		});
		expect(plain.ok).toBe(false);
	});

	test("a redirect to a Hugging Face CDN host is followed", async () => {
		const h = home();
		const f = hf();
		const inner = f.fetchImpl;
		const r = await fetchJudgeModel({
			env: { EIGHT_HOME: h },
			pin,
			model,
			fetchImpl: async (u) =>
				u.endsWith("the-judge.gguf")
					? new Response(null, {
							status: 302,
							headers: { location: "https://cas-bridge.xethub.hf.co/x/resolve/f" },
						})
					: inner(u),
		});
		// The CDN hop was allowed and the file it served matched the pin.
		expect(r.ok).toBe(true);
	});

	test("the real pin is the calibrated judge's repo and file hash", () => {
		expect(judgeRepo()).toBe("AtlaAI/Selene-1-Mini-Llama-3.1-8B-Q4_K_M-GGUF");
		expect(judgeRepo(JUDGE_MODEL)).not.toBeNull();
		expect(JUDGE_GGUF.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(JUDGE_GGUF.bytes).toBe(4_920_739_424);
		expect(judgeRepo("llama3.2:3b")).toBeNull();
	});
});

describe("the judge model is a table keyed by device RAM", () => {
	const GiB = 2 ** 30;
	test("Selene only from 12 GB; below that no pin, so no download", () => {
		expect(judgeModelFor(12 * GiB)).toBe(JUDGE_GGUF);
		expect(judgeModelFor(64 * GiB)).toBe(JUDGE_GGUF);
		expect(judgeModelFor(11.9 * GiB)).toBeNull();
		expect(judgeModelFor(8 * GiB)).toBeNull();
		expect(judgeModelFor(0)).toBeNull();
		expect(judgeModelFor(Number.NaN)).toBeNull();
	});

	test("the table is ordered, every pin is a full sha256, and there is no third-party small model", () => {
		const mins = JUDGE_MODELS.map((m) => m.minRamBytes);
		expect(mins).toEqual([...mins].sort((a, b) => b - a));
		for (const m of JUDGE_MODELS) expect(m.pin.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(JUDGE_MODELS.map((m) => m.pin.sha256)).toEqual([JUDGE_GGUF.sha256]);
	});
});
