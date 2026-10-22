/**
 * Greeting welcome (#4767).
 *
 * "what good" on a phone should get a short hello that says who is answering
 * and shows one useful thing, at zero model tokens. The block is built by code
 * from local facts only: the version, the host, the configured model and
 * provider, which /term presets have a binary on PATH, and whether the folder
 * is a git repo. Nothing here reads a file's contents, touches the network or
 * runs a program: PATH is checked with an access() call per directory and the
 * repo check is an existence test for `.git`.
 *
 * Builds on the small-talk gate (#4760): a turn that is not a greeting, or
 * whose facts cannot be gathered, keeps the plain [SMALL TALK] note.
 */

import { existsSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { findOnPath, isAndroidHost } from "../voice/termux";

type Env = Record<string, string | undefined>;

export interface WelcomePreset {
	id: string;
	command: string;
}

export interface WelcomeFacts {
	version: string;
	host: string;
	android: boolean;
	model: string;
	provider: string;
	/** Every preset this build knows, in order. */
	presetIds: string[];
	/** The presets whose binary is on PATH right now. */
	installed: string[];
	folder: string;
	gitRepo: boolean;
}

/**
 * PATH with every entry that could hold a binary planted by the folder itself
 * removed: relative entries ("." , "bin", "node_modules/.bin") and absolute ones
 * inside `cwd`. The welcome never offers to run a program a cloned repo shipped.
 */
export function pathOutsideFolder(path: string, cwd: string): string {
	const root = resolve(cwd);
	return path
		.split(delimiter)
		.filter((dir) => {
			if (!dir || !isAbsolute(dir)) return false;
			const rel = relative(root, resolve(dir));
			return rel.startsWith("..") || isAbsolute(rel);
		})
		.join(delimiter);
}

/**
 * The model name as shown: a value that looks like a URL or carries credentials
 * (`://`, `@`, `?`, whitespace) is never echoed into a transcript.
 */
export function safeModelLabel(model: string): string {
	const m = model.trim();
	if (!m || m.length > 80 || /:\/\/|[@?\s]/.test(m)) return "a custom model";
	return m;
}

/** True when `dir` or a folder above it holds a `.git` entry. Existence only. */
export function inGitRepo(dir: string): boolean {
	let d = dir;
	for (let i = 0; i < 64; i++) {
		if (existsSync(join(d, ".git"))) return true;
		const up = dirname(d);
		if (up === d) return false;
		d = up;
	}
	return false;
}

function hostLabel(android: boolean, platform: string, arch: string): string {
	if (android) return `Android (Termux, ${arch})`;
	const os =
		platform === "darwin"
			? "macOS"
			: platform === "linux"
				? "Linux"
				: platform === "win32"
					? "Windows"
					: platform;
	return `${os} ${arch}`;
}

async function knownPresets(): Promise<WelcomePreset[]> {
	const runner = await import("../../apps/tui/src/lib/external-agent-runner.js");
	const out: WelcomePreset[] = [];
	for (const id of runner.listPresetIds()) {
		const p = runner.getPreset(id);
		if (p) out.push({ id: p.id, command: p.command });
	}
	return out;
}

/** Gather the facts. Throws only if a fact source throws; the caller falls back. */
export async function gatherWelcomeFacts(opts: {
	model: string;
	provider: string;
	cwd: string;
	env?: Env;
	platform?: string;
	arch?: string;
	presets?: WelcomePreset[];
}): Promise<WelcomeFacts> {
	const env = opts.env ?? process.env;
	const android = isAndroidHost(opts.platform ?? process.platform, env);
	// 8gent itself is a preset (8gent inside 8gent); offering it beside itself says nothing.
	const cwd = resolve(opts.cwd);
	const home = env.HOME ? resolve(env.HOME) : null;
	const lookupEnv = { ...env, PATH: pathOutsideFolder(String(env.PATH ?? ""), cwd) };
	const presets = (opts.presets ?? (await knownPresets())).filter((p) => p.id !== "8gent");
	return {
		version: String(pkg.version),
		host: hostLabel(android, opts.platform ?? process.platform, opts.arch ?? process.arch),
		android,
		model: safeModelLabel(opts.model),
		provider: opts.provider,
		presetIds: presets.map((p) => p.id),
		installed: presets.filter((p) => findOnPath(p.command, lookupEnv) !== null).map((p) => p.id),
		folder: cwd === home ? "~" : basename(cwd) || "/",
		gitRepo: inGitRepo(cwd),
	};
}

function listWords(items: string[]): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The welcome block: at most seven short lines. Same facts, same text. */
export function buildWelcome(f: WelcomeFacts): string {
	const where = f.android ? "phone" : "machine";
	const lines = [`Hi, I'm 8gent v${f.version} on ${f.host}, using ${f.model} via ${f.provider}.`];
	if (f.installed.length > 0) {
		lines.push(
			`On this ${where} I found ${listWords(f.installed)}. Say "run ${f.installed[0]}" and I'll open it in a tab beside me.`,
		);
	} else {
		lines.push(
			`I checked PATH for ${listWords(f.presetIds)}: none installed, so it's just me here.`,
		);
	}
	lines.push(
		f.gitRepo
			? `This folder (${f.folder}) is a git repo, so I can read its history and run its tests.`
			: `This folder (${f.folder}) is not a git repo. I won't look through it unless you ask.`,
	);
	const next: string[] = [];
	if (f.installed.length > 0) next.push(`run ${f.installed[0]}`);
	next.push(
		f.gitRepo
			? "what changed in the last commit"
			: "make a folder called demo with a hello web page",
	);
	next.push("what can you do");
	lines.push("Try:", ...next.map((n) => `  "${n}"`));
	return lines.join("\n");
}
