/**
 * Opt-in local embedder: EmbeddingGemma 2 (GGUF) served by llama.cpp.
 *
 * Nothing here runs unless the user enables it. Nothing is downloaded without
 * a typed yes at a TTY; no TTY, CI, or a daemon means no. The file comes from
 * one pinned Hugging Face URL, is checked against a pinned sha256, and is
 * deleted if the hash differs. After that the model runs on 127.0.0.1 only.
 */

import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const EMBEDDER = {
	id: "embeddinggemma-2",
	/** Provider-facing model name, stored in embeddings.model to keep vector spaces apart. */
	model: "embeddinggemma-2-q8_0",
	dimensions: 768,
	licence: "Apache-2.0 (card) with the Gemma Prohibited Use Policy",
	policyUrl: "https://ai.google.dev/gemma/prohibited_use_policy",
	url: "https://huggingface.co/ggml-org/embeddinggemma-2-GGUF/resolve/main/embeddinggemma-2-Q8_0.gguf",
	file: "embeddinggemma-2-Q8_0.gguf",
	bytes: 309_855_456,
	sha256: "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
	port: 8189,
	/** Oldest llama.cpp release known to load gemma-embedding2 (0.8.0 loads it; 0.5.0 does not). */
	minLlamaCpp: [0, 8, 0],
} as const;

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return 0;
}

export interface LlamaServerCheck {
	ok: boolean;
	/** Plain-language reason when not ok. */
	reason?: string;
}

/** Is llama-server present, and new enough to load EmbeddingGemma 2? Runs `llama-server --version` only. */
export function checkLlamaServer(
	which: (b: string) => string | null = (b) => Bun.which(b),
	versionOutput: (bin: string) => string = (bin) => {
		const r = Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "pipe" });
		return `${r.stdout.toString()}${r.stderr.toString()}`;
	},
): LlamaServerCheck {
	const bin = which("llama-server");
	if (!bin) {
		return { ok: false, reason: "llama.cpp is not installed (no llama-server found). Install it first, then run this again. Nothing was downloaded." };
	}
	const m = /version:\s*(\d+)\.(\d+)\.(\d+)/.exec(versionOutput(bin));
	const want = EMBEDDER.minLlamaCpp;
	const have = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
	const newEnough = have !== null && compareVersions(have, want) >= 0;
	if (!newEnough) {
		return {
			ok: false,
			reason: `Your llama.cpp (${have ? have.join(".") : "version unknown"}) is too old for EmbeddingGemma 2; it needs ${want.join(".")} or newer. Update it, then run this again. Nothing was downloaded.`,
		};
	}
	return { ok: true };
}

/** The only hosts a download may touch, including redirect hops. */
export function isAllowedHost(host: string): boolean {
	return host === "huggingface.co" || host.endsWith(".hf.co") || host === "hf.co";
}

export function modelsDir(base = join(homedir(), ".8gent")): string {
	return join(base, "models");
}

interface EmbedderConfig {
	id: string;
	path: string;
	sha256: string;
}

export function readEmbedderConfig(base?: string): EmbedderConfig | null {
	try {
		const cfg = JSON.parse(readFileSync(join(modelsDir(base), "embedder.json"), "utf8")) as EmbedderConfig;
		if (cfg.id === EMBEDDER.id && existsSync(cfg.path) && statSync(cfg.path).size === EMBEDDER.bytes) return cfg;
	} catch {
		// not enabled
	}
	return null;
}

export function consentText(): string {
	const mb = Math.round(EMBEDDER.bytes / 1_000_000);
	return [
		"EmbeddingGemma 2 is the recommended local model for memory search.",
		"It finds memories by meaning, not just matching words, and runs on this machine.",
		"",
		`  Model:    ${EMBEDDER.id}`,
		`  Licence:  ${EMBEDDER.licence}`,
		`  Policy:   ${EMBEDDER.policyUrl}`,
		`  Size:     ${mb} MB, one time`,
		`  From:     ${EMBEDDER.url}`,
		"",
		"Nothing leaves your device after the download. Without it, memory keeps working as it does today.",
	].join("\n");
}

/** Hash a file on disk. */
export async function sha256File(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
	return hash.digest("hex");
}

/**
 * Download the pinned file. Follows redirects by hand so every hop is checked
 * against the host allowlist. Verifies size and sha256 before the file takes
 * its final name; a mismatch deletes it.
 */
export async function downloadModel(opts: {
	dest?: string;
	fetchImpl?: typeof fetch;
	url?: string;
	sha256?: string;
	onProgress?: (done: number, total: number) => void;
} = {}): Promise<string> {
	const dest = opts.dest ?? join(modelsDir(), EMBEDDER.file);
	const expected = opts.sha256 ?? EMBEDDER.sha256;
	const doFetch = opts.fetchImpl ?? fetch;
	mkdirSync(join(dest, ".."), { recursive: true });

	let url = opts.url ?? EMBEDDER.url;
	let res: Response | null = null;
	for (let hop = 0; hop < 6; hop++) {
		const u = new URL(url);
		if (u.protocol !== "https:" || !isAllowedHost(u.hostname)) {
			throw new Error(`download refused: ${u.hostname} is not an allowed host`);
		}
		res = await doFetch(url, { redirect: "manual" });
		if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
			url = new URL(res.headers.get("location") as string, url).toString();
			continue;
		}
		break;
	}
	if (!res || !res.ok || !res.body) throw new Error(`download failed: HTTP ${res?.status ?? "none"}`);

	const part = `${dest}.part`;
	const out = createWriteStream(part);
	const hash = createHash("sha256");
	const total = Number(res.headers.get("content-length") ?? 0);
	let done = 0;
	try {
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			hash.update(chunk);
			if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
			done += chunk.length;
			opts.onProgress?.(done, total);
		}
		await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
	} catch (err) {
		rmSync(part, { force: true });
		throw err;
	}
	const got = hash.digest("hex");
	if (got !== expected) {
		rmSync(part, { force: true });
		throw new Error(`hash mismatch: expected ${expected}, got ${got}; file deleted`);
	}
	renameSync(part, dest);
	return dest;
}

/** Plain-language yes/no. Anything but y or yes is No. */
export function askYesNo(question: string, input: NodeJS.ReadableStream = process.stdin): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input, output: process.stdout });
		rl.question(`${question} [y/N] `, (answer) => {
			resolve(/^y(es)?$/i.test(answer.trim()));
			rl.close();
		});
		rl.once("close", () => resolve(false));
	});
}

export type EnableResult = "enabled" | "declined" | "unattended" | "already-enabled" | "no-runtime";

/** Unattended means no: no TTY, CI, or a daemon never prompts and never downloads. */
export function isAttended(env: NodeJS.ProcessEnv = process.env, tty = !!process.stdin.isTTY && !!process.stdout.isTTY): boolean {
	return tty && !env.CI && !env.EIGHT_DAEMON;
}

export async function enableEmbedder(opts: {
	base?: string;
	attended?: boolean;
	ask?: (q: string) => Promise<boolean>;
	download?: typeof downloadModel;
	checkRuntime?: () => LlamaServerCheck;
	log?: (s: string) => void;
} = {}): Promise<EnableResult> {
	const log = opts.log ?? ((s: string) => console.log(s));
	if (readEmbedderConfig(opts.base)) return "already-enabled";
	const runtime = (opts.checkRuntime ?? checkLlamaServer)();
	if (!runtime.ok) {
		log(`embedder: not enabled. ${runtime.reason}`);
		return "no-runtime";
	}
	if (!(opts.attended ?? isAttended())) {
		log("embedder: not enabled. No terminal to ask in, so nothing was downloaded.");
		return "unattended";
	}
	log(consentText());
	log("");
	if (!(await (opts.ask ?? askYesNo)("Download it now?"))) {
		log("Not downloaded. Memory search stays as it is.");
		return "declined";
	}
	const dest = await (opts.download ?? downloadModel)({
		dest: join(modelsDir(opts.base), EMBEDDER.file),
		onProgress: (d, t) => process.stdout.isTTY && t && process.stdout.write(`\r  ${Math.round((d / t) * 100)}%`),
	});
	writeFileSync(
		join(modelsDir(opts.base), "embedder.json"),
		JSON.stringify({ id: EMBEDDER.id, path: dest, sha256: EMBEDDER.sha256 }, null, 2),
	);
	log("\nEnabled. New memories are indexed with it. Older ones keep working through word search.");
	return "enabled";
}

export function disableEmbedder(base?: string): void {
	rmSync(join(modelsDir(base), "embedder.json"), { force: true });
}

/** Start llama-server on loopback if it is not already answering. Returns the base URL or null. */
export async function ensureEmbedderServer(cfg: EmbedderConfig, port: number = EMBEDDER.port): Promise<string | null> {
	const baseUrl = `http://127.0.0.1:${port}`;
	const healthy = async () => {
		try {
			return (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1500) })).ok;
		} catch {
			return false;
		}
	};
	if (await healthy()) return baseUrl;
	const bin = Bun.which("llama-server");
	if (!bin) return null;
	const proc = Bun.spawn(
		[bin, "-m", cfg.path, "--embedding", "--host", "127.0.0.1", "--port", String(port), "--ctx-size", "2048", "--log-disable"],
		{ stdout: "ignore", stderr: "ignore", stdin: "ignore" },
	);
	proc.unref();
	let exited = false;
	void proc.exited.then(() => {
		exited = true;
	});
	// An older llama.cpp exits at once on an architecture it does not know; do not wait out the clock.
	for (let i = 0; i < 60 && !exited; i++) {
		if (await healthy()) return baseUrl;
		await new Promise((r) => setTimeout(r, 500));
	}
	return null;
}
