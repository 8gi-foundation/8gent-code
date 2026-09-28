/**
 * Finding: scripts/postinstall.js ran `npx bmad-method init --no-interactive`,
 * which fetched and executed an unpinned package from the public registry on
 * every install. That breaks 8GI-SECURITY.md 3.2 (no install scripts that run
 * unreviewed code) and Constitution Article 6 (nothing reaches the network on
 * the user's behalf without an explicit opt-in).
 *
 * Fix: PR 2969 (commit 660ae619).
 * credit: Artale (8SO)
 *
 * Static scan of the whole install path: every root lifecycle script, the
 * files they run, and the one build script postinstall shells out to (plus its
 * Swift manifest, which must declare no remote package dependencies, or
 * `swift build` would fetch them). Comments are stripped first, because the
 * postinstall header deliberately quotes the removed command as an opt-in hint.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const LIFECYCLE = ["preinstall", "install", "postinstall", "prepare", "prepublish", "preprepare", "postprepare"];

// Network-capable calls or tools. Each pattern names one way code can reach
// the network; the test reports which one matched.
const NETWORK_PATTERNS: Array<[string, RegExp]> = [
	["fetch()", /\bfetch\s*\(/],
	["http(s) module", /(?:from\s+|require\s*\(\s*)["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']/],
	["URL literal", /\bhttps?:\/\//],
	["curl", /\bcurl\b/],
	["wget", /\bwget\b/],
	["npx / bunx / pnpm dlx", /\b(?:npx|bunx|dlx)\b/],
	["package install", /\b(?:npm|bun|pnpm|yarn)\s+(?:i|install|add)\b/],
	["git fetch/clone/pull", /\bgit\s+(?:clone|fetch|pull)\b/],
	["XMLHttpRequest / WebSocket", /\b(?:XMLHttpRequest|WebSocket)\b/],
];

function stripJsComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function stripShComments(src: string): string {
	return src
		.split("\n")
		.map((l) => (l.trimStart().startsWith("#") ? "" : l))
		.join("\n");
}

function scan(label: string, code: string): string[] {
	return NETWORK_PATTERNS.filter(([, re]) => re.test(code)).map(([name]) => `${label}: ${name}`);
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
const scripts: Record<string, string> = pkg.scripts ?? {};

describe("install path makes no network call (PR 2969)", () => {
	test("root lifecycle script command lines contain no network tool", () => {
		const hits: string[] = [];
		for (const name of LIFECYCLE) if (scripts[name]) hits.push(...scan(`package.json scripts.${name}`, scripts[name]));
		expect(hits).toEqual([]);
	});

	test("every file a lifecycle script runs is free of network calls", () => {
		const hits: string[] = [];
		let scanned = 0;
		for (const name of LIFECYCLE) {
			const cmd = scripts[name];
			if (!cmd) continue;
			for (const m of cmd.matchAll(/(?:^|\s)((?:\.\/)?[\w./-]+\.(?:m?js|cjs|ts|sh))\b/g)) {
				const file = join(REPO_ROOT, m[1]);
				// A lifecycle script pointing at a file that does not exist is
				// itself a finding: the scan would be vacuous.
				expect(existsSync(file)).toBe(true);
				const src = readFileSync(file, "utf-8");
				hits.push(...scan(m[1], m[1].endsWith(".sh") ? stripShComments(src) : stripJsComments(src)));
				scanned++;
			}
		}
		expect(scripts.postinstall).toBeDefined();
		expect(scanned).toBeGreaterThan(0);
		expect(hits).toEqual([]);
	});

	test("postinstall does not import exec/execFile (the removed npx path)", () => {
		const src = stripJsComments(readFileSync(join(REPO_ROOT, "scripts", "postinstall.js"), "utf-8"));
		expect(src).not.toMatch(/\bexec(?:File)?(?:Sync)?\b/);
		// The only child process it may start is the bundled bridge build.
		const spawned = [...src.matchAll(/spawnSync\s*\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
		expect(spawned.every((c) => c === "bash")).toBe(true);
	});

	test("the bridge build postinstall shells out to is offline, and its Swift package has no remote dependencies", () => {
		const build = join(REPO_ROOT, "packages", "eyes", "native", "build.sh");
		const manifest = join(REPO_ROOT, "packages", "eyes", "native", "swift", "Package.swift");
		expect(scan("build.sh", stripShComments(readFileSync(build, "utf-8")))).toEqual([]);
		const swift = stripJsComments(readFileSync(manifest, "utf-8"));
		expect(swift).not.toMatch(/\.package\s*\(/);
		expect(swift).not.toMatch(/\bdependencies\s*:/);
	});
});
