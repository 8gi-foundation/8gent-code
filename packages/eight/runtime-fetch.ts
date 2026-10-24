/**
 * 8gent's own llama-server, and the judge model, fetched on first need (#4906).
 *
 * llama-server comes from 8gent's own GitHub release for the running version
 * (asset `llama-server-<target>`, built by .github/workflows/runtime-binaries.yml),
 * checked against that release's SHA256SUMS (and its minisign signature once a release
 * key is configured), written beside its destination and renamed into ~/.8gent/bin
 * atomically, then run with --version. Nothing comes from pkg, brew or Ollama.
 *
 * The judge model is the calibrated one (packages/decide/judge-model.ts), Q4_K_M, from its
 * official Hugging Face repo. Its sha256 and size are pinned here: the repo is searched
 * for the file whose LFS hash is the pinned one, so no file name is trusted, and the
 * download is hashed as it streams and refused on any mismatch. Other quants are not
 * offered: the judge's thresholds were fitted on this one.
 *
 * Every network and disk effect is injected so tests download nothing.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsc,
	mkdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../../package.json";
import { resolveHome } from "../core/home";
import { JUDGE_MODEL } from "../decide/judge-model";
import { findOnPath, isAndroidHost } from "../voice/termux";
import { managedLlamaServer, openPrivate } from "./local-runtime";
import pins from "./runtime-pins.json";
import {
	type FetchLike,
	GITHUB_REPO,
	RELEASE_SIGNING_KEY,
	fetchChecked,
	sumFor,
	verifyMinisign,
} from "./self-update";

type Env = Record<string, string | undefined>;

export type Target = (typeof pins.targets)[number];

/** The release target of the machine running 8gent, or null (Windows is not built yet). */
export function runtimeTarget(
	platform: string = process.platform,
	arch: string = process.arch,
	env: Env = process.env,
): Target | null {
	const a = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
	if (!a) return null;
	let t: string | null = null;
	if (isAndroidHost(platform, env)) t = a === "arm64" ? "android-arm64" : null;
	else if (platform === "linux") t = `linux-${a}`;
	else if (platform === "darwin") t = `darwin-${a}`;
	return t && (pins.targets as string[]).includes(t) ? (t as Target) : null;
}

/** The release asset name for a program on a target, from the pins' naming rule. */
export function assetName(program: "llama-server" | "whisper-cli", target: Target): string {
	return pins.assets[program].replace("{target}", target);
}

export const releaseUrl = (version: string, name: string): string =>
	`https://github.com/${GITHUB_REPO}/releases/download/v${version}/${name}`;

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── llama-server ─────────────────────────────────────────────────────────

export interface FetchDeps {
	env?: Env;
	platform?: string;
	arch?: string;
	/** The running version. Default: this package's. */
	version?: string;
	fetchImpl?: FetchLike;
	/** Run `<bin> --version`; true on exit 0. */
	runs?: (bin: string) => boolean;
	signingKey?: string;
}

export type BinaryResult = { ok: true; bin: string } | { ok: false; why: string };

const defaultRuns = (bin: string) =>
	spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 15_000 }).status === 0;

async function body(f: FetchLike, url: string): Promise<Uint8Array> {
	const res = await fetchChecked(f, url, "asset");
	if (!res.ok) throw new Error(`${url} answered ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

/**
 * Download, verify and install llama-server for this machine and version. On any failure
 * nothing is left in ~/.8gent/bin and the reason is returned.
 */
export async function fetchLlamaServer(deps: FetchDeps = {}): Promise<BinaryResult> {
	const env = deps.env ?? process.env;
	const target = runtimeTarget(deps.platform, deps.arch, env);
	if (!target) return { ok: false, why: "8gent has no llama-server build for this platform yet" };
	const f: FetchLike = deps.fetchImpl ?? ((u, i) => fetch(u, i));
	const version = deps.version ?? pkg.version;
	const name = assetName("llama-server", target);
	const dest = managedLlamaServer(env);
	const part = `${dest}.part-${randomBytes(4).toString("hex")}`;
	try {
		const sumsBytes = await body(f, releaseUrl(version, "SHA256SUMS"));
		const key = (deps.signingKey ?? RELEASE_SIGNING_KEY).trim();
		if (key) {
			const sig = new TextDecoder().decode(
				await body(f, releaseUrl(version, "SHA256SUMS.minisig")),
			);
			if (!verifyMinisign(sumsBytes, sig, key))
				return { ok: false, why: `SHA256SUMS for v${version} has no valid release signature` };
		}
		const want = sumFor(new TextDecoder().decode(sumsBytes), name);
		if (!want) return { ok: false, why: `v${version} has no ${name} in its SHA256SUMS` };
		const bytes = await body(f, releaseUrl(version, name));
		if (sha256Hex(bytes) !== want)
			return {
				ok: false,
				why: `${name} does not match the release's SHA256SUMS; it was not installed`,
			};
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(part, bytes, { mode: 0o755, flag: "wx" });
		chmodSync(part, 0o755);
		if (!(deps.runs ?? defaultRuns)(part))
			return { ok: false, why: `${name} downloaded and verified but would not run on this device` };
		renameSync(part, dest);
		return { ok: true, bin: dest };
	} catch (err) {
		return { ok: false, why: err instanceof Error ? err.message : String(err) };
	} finally {
		try {
			unlinkSync(part);
		} catch {}
	}
}

export type LlamaServerSource = "managed" | "fetched" | "system";
export type LlamaServerResult =
	| { ok: true; bin: string; source: LlamaServerSource; note?: string }
	| { ok: false; why: string };

/** An llama-server already on this machine: the one 8gent installed, else one on PATH. */
export function findLlamaServer(
	env: Env = process.env,
	exists: (p: string) => boolean = existsSync,
	find: (n: string) => string | null = (n) => findOnPath(n, env),
): { bin: string; source: "managed" | "system" } | null {
	const managed = managedLlamaServer(env);
	if (exists(managed)) return { bin: managed, source: "managed" };
	const sys = find("llama-server");
	return sys ? { bin: sys, source: "system" } : null;
}

export interface EnsureDeps extends FetchDeps {
	exists?: (p: string) => boolean;
	find?: (n: string) => string | null;
	fetchBinary?: (d: FetchDeps) => Promise<BinaryResult>;
}

/**
 * The llama-server to run, in this order: the one 8gent installed, 8gent's own release for
 * this version, and only if that fails a system one on PATH. A system llama-server is a
 * fallback, never the default.
 */
export async function ensureLlamaServer(deps: EnsureDeps = {}): Promise<LlamaServerResult> {
	const env = deps.env ?? process.env;
	const exists = deps.exists ?? existsSync;
	const managed = managedLlamaServer(env);
	if (exists(managed)) return { ok: true, bin: managed, source: "managed" };
	const got = await (deps.fetchBinary ?? fetchLlamaServer)(deps);
	if (got.ok) return { ok: true, bin: got.bin, source: "fetched" };
	const sys = (deps.find ?? ((n: string) => findOnPath(n, env)))("llama-server");
	if (sys) return { ok: true, bin: sys, source: "system", note: got.why };
	return { ok: false, why: got.why };
}

// ── judge model ──────────────────────────────────────────────────────────

/** The calibrated judge, Q4_K_M. sha256 is the file's (checked against the Ollama store copy), bytes its size. */
export const JUDGE_GGUF = {
	sha256: "b8ce1f01dd99d03b75dd1bb7a69fa25d609eff8c92ab118630c05a7a70829481",
	bytes: 4_920_739_424,
} as const;

/** "hf.co/<owner>/<repo>:<tag>" (the calibrated model name) to "<owner>/<repo>"; null for anything else. */
export function judgeRepo(model: string = JUDGE_MODEL): string | null {
	const m = /^hf\.co\/([^/:]+\/[^/:]+)(?::.+)?$/.exec(model);
	return m ? m[1] : null;
}

export interface Pin {
	sha256: string;
	bytes: number;
}

export const judgeModelPath = (env: Env = process.env, pin: Pin = JUDGE_GGUF): string =>
	join(resolveHome(env), ".8gent", "models", "judge", `${pin.sha256.slice(0, 12)}.gguf`);

/** True when the verified file is in place (size checked; it was hashed when it was downloaded). */
export function judgeModelPresent(env: Env = process.env, pin: Pin = JUDGE_GGUF): boolean {
	try {
		return statSync(judgeModelPath(env, pin)).size === pin.bytes;
	} catch {
		return false;
	}
}

const HF_HOSTS = (h: string) =>
	h === "huggingface.co" || h.endsWith(".huggingface.co") || h.endsWith(".hf.co");

/** GET following redirects by hand: https only, Hugging Face hosts only, no credentials sent. */
async function hfGet(f: HttpFetch, url: string): Promise<Response> {
	let cur = url;
	for (let hop = 0; hop <= 5; hop++) {
		const u = new URL(cur);
		if (u.protocol !== "https:" || !HF_HOSTS(u.hostname))
			throw new Error(`refusing to download from ${cur}`);
		const res = await f(cur, { redirect: "manual" });
		if (res.status >= 300 && res.status < 400) {
			const loc = res.headers.get("location");
			if (!loc) throw new Error(`redirect without a location from ${cur}`);
			cur = new URL(loc, cur).href;
			continue;
		}
		return res;
	}
	throw new Error("too many redirects");
}

/** fetch, as the model download needs it (a streamed body). */
export type HttpFetch = (url: string, init?: { redirect?: "manual" }) => Promise<Response>;

export interface ModelDeps {
	env?: Env;
	fetchImpl?: HttpFetch;
	onPercent?: (pct: number) => void;
	/** Tests pass a small pin; production uses JUDGE_GGUF. */
	pin?: Pin;
	/** The model name to find a repo for. Default: the calibrated judge. */
	model?: string;
}

export type ModelResult = { ok: true; path: string } | { ok: false; why: string };

/** Fetch and verify the judge GGUF. Atomic: the final name only ever holds a file that matched. */
export async function fetchJudgeModel(deps: ModelDeps = {}): Promise<ModelResult> {
	const env = deps.env ?? process.env;
	const pin = deps.pin ?? JUDGE_GGUF;
	const dest = judgeModelPath(env, pin);
	if (judgeModelPresent(env, pin)) return { ok: true, path: dest };
	const repo = judgeRepo(deps.model);
	if (!repo) return { ok: false, why: "the judge model has no Hugging Face repo to fetch from" };
	const f: HttpFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
	const part = `${dest}.part`;
	let fd = -1;
	try {
		const listRes = await hfGet(f, `https://huggingface.co/api/models/${repo}/tree/main`);
		if (!listRes.ok)
			return { ok: false, why: `Hugging Face answered ${listRes.status} for ${repo}` };
		const tree = (await listRes.json()) as Array<{
			path?: string;
			lfs?: { oid?: string; size?: number };
		}>;
		const file = tree.find((t) => t.lfs?.oid === pin.sha256 && typeof t.path === "string");
		if (!file?.path) return { ok: false, why: `${repo} has no file with the pinned checksum` };
		const res = await hfGet(
			f,
			`https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file.path)}`,
		);
		if (!res.ok || !res.body)
			return { ok: false, why: `Hugging Face answered ${res.status} for the model file` };
		fd = openPrivate(part, fsc.O_WRONLY | fsc.O_TRUNC);
		const hash = createHash("sha256");
		let got = 0;
		let last = -1;
		const reader = res.body.getReader();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			got += value.byteLength;
			if (got > pin.bytes)
				return { ok: false, why: "the model download is larger than its pinned size; stopped" };
			hash.update(value);
			for (let off = 0; off < value.byteLength; ) off += writeSync(fd, value, off);
			const pct = Math.floor((got / pin.bytes) * 100);
			if (pct !== last) {
				last = pct;
				deps.onPercent?.(pct);
			}
		}
		closeSync(fd);
		fd = -1;
		if (got !== pin.bytes || hash.digest("hex") !== pin.sha256)
			return {
				ok: false,
				why: "the downloaded model does not match its pinned checksum; it was deleted",
			};
		renameSync(part, dest);
		return { ok: true, path: dest };
	} catch (err) {
		return { ok: false, why: err instanceof Error ? err.message : String(err) };
	} finally {
		if (fd >= 0) closeSync(fd);
		if (existsSync(part)) {
			try {
				unlinkSync(part);
			} catch {}
		}
	}
}
