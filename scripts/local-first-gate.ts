#!/usr/bin/env bun
/**
 * Local-first gate: nothing that sends user data off the device is a default.
 *
 * Reads scripts/local-first-sinks.ts (the one list) and the shipped source, and
 * fails when:
 *   1. a hostname appears in shipped code that no entry covers (a new sink);
 *   2. a sink with `files` is reached from a file outside them (a way round its guard);
 *   3. an `optin` sink's guard no longer matches (the yes is gone);
 *   4. a `default` sink, or a failed guard, has no waiver, or its waiver expired;
 *   5. a file reads Ollama's /api/tags without the cloud-tag filter and is not reviewed;
 *   6. a file that starts `ollama serve` does not set OLLAMA_NO_CLOUD;
 *   7. install text (pkg, apt, brew, pip, npm -g, ollama pull or serve, cmake) appears in a
 *      file INSTALL_SITES does not list and without a `local-first-gate: optin|fallback` marker;
 *   8. a file listed as `default` there has no waiver, or its waiver expired.
 *
 * Usage: bun scripts/local-first-gate.ts [--no-waivers] [--json] [--root <checkout>]
 *   --no-waivers  ignore every waiver: shows what main would fail on without the
 *                 known-item list. Exit 1 while any default-path sink remains.
 *
 *   --root        gate another checkout of the repo (a git work tree), using this list.
 *
 * Deterministic: no network, no clock except the waiver expiry (TODAY env overrides).
 * Limits, stated plainly: it reads text. A host built by string concatenation, a
 * URL held in an environment variable, or a sink reached through a dependency is
 * not seen. The sink list and the review checklist cover what a regex cannot.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CODE_EXT,
	EXCLUDED_PATH,
	INSTALL_EXCLUDED_PATH,
	INSTALL_MARKER,
	INSTALL_OWN,
	INSTALL_PATTERNS,
	INSTALL_SITES,
	type InstallSite,
	LOCAL_HOST,
	OLLAMA_TAG_READERS_REVIEWED,
	SCOPE_DIRS,
	SINKS,
	type Sink,
} from "./local-first-sinks";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface Finding {
	rule:
		| "new-host"
		| "new-path"
		| "guard-missing"
		| "default-sink"
		| "waiver"
		| "tags-reader"
		| "serve-env"
		| "new-install"
		| "default-install";
	sink?: string;
	file?: string;
	detail: string;
}

export interface GateResult {
	failures: Finding[];
	waived: Finding[];
	warnings: string[];
}

export interface GateOptions {
	sinks?: Sink[];
	installSites?: InstallSite[];
	reviewedTagReaders?: Record<string, string>;
	noWaivers?: boolean;
	/** YYYY-MM-DD. */
	today?: string;
}

/** The helper itself describes /api/tags in prose. */
const OLLAMA_CLOUD_HELPER = "packages/core/ollama-cloud.ts";

const URL_HOST = /\b(?:https?|wss?):\/\/([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})/g;

export function inScope(path: string): boolean {
	return (
		SCOPE_DIRS.some((d) => path.startsWith(d)) && CODE_EXT.test(path) && !EXCLUDED_PATH.test(path)
	);
}

function hostMatches(pattern: string, host: string): boolean {
	return pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern;
}

function fileAllowed(file: string, allowed: string[] | undefined): boolean {
	if (!allowed) return true;
	return allowed.some((a) => (a.endsWith("/") ? file.startsWith(a) : file === a));
}

/** Hostnames in a text, lower-cased, with this-machine hosts removed. */
export function hostsIn(text: string): string[] {
	const out = new Set<string>();
	for (const m of text.matchAll(URL_HOST)) {
		const h = m[1].toLowerCase().replace(/\.+$/, "");
		if (!LOCAL_HOST.test(h)) out.add(h);
	}
	return [...out];
}

/** Install text lines with no opt-in or fallback marker on the line or the 8 above it. */
export function installLines(text: string): { n: number; line: string }[] {
	const lines = text.split("\n");
	const out: { n: number; line: string }[] = [];
	lines.forEach((line, i) => {
		if (/^\s*(\/\/|\*|\/\*)/.test(line) || INSTALL_OWN.test(line)) return;
		if (!INSTALL_PATTERNS.some((p) => p.test(line))) return;
		if (lines.slice(Math.max(0, i - 8), i + 1).some((l) => INSTALL_MARKER.test(l))) return;
		out.push({ n: i + 1, line: line.trim().slice(0, 100) });
	});
	return out;
}

/** Pure: `files` maps repo-relative path to text, already limited to shipped source. */
export function runGate(files: Map<string, string>, opts: GateOptions = {}): GateResult {
	const sinks = opts.sinks ?? SINKS;
	const reviewed = opts.reviewedTagReaders ?? OLLAMA_TAG_READERS_REVIEWED;
	const installSites = opts.installSites ?? INSTALL_SITES;
	const today = opts.today ?? process.env.TODAY ?? new Date().toISOString().slice(0, 10);
	const failures: Finding[] = [];
	const waived: Finding[] = [];
	const warnings: string[] = [];
	const seenHosts = new Set<string>();

	const settle = (sink: { id: string; waiver?: Sink["waiver"] } | undefined, f: Finding) => {
		const w = sink?.waiver;
		if (!w || opts.noWaivers) return failures.push(f);
		if (!/#\d+/.test(w.ref) || !/^\d{4}-\d{2}-\d{2}$/.test(w.expires)) {
			return failures.push({
				rule: "waiver",
				sink: sink?.id,
				detail: `waiver needs an issue ref like #123 and a YYYY-MM-DD expiry, got ${w.ref} / ${w.expires}`,
			});
		}
		if (w.expires < today) {
			return failures.push({
				rule: "waiver",
				sink: sink?.id,
				detail: `waiver ${w.ref} expired ${w.expires}; ${f.detail}`,
			});
		}
		waived.push({ ...f, detail: `${f.detail} [waived by ${w.ref} until ${w.expires}: ${w.why}]` });
	};

	// 1 + 2: hosts and patterns
	for (const [file, text] of files) {
		for (const host of hostsIn(text)) {
			seenHosts.add(host);
			const owner = sinks.find((s) => s.hosts?.some((p) => hostMatches(p, host)));
			if (!owner) {
				failures.push({
					rule: "new-host",
					file,
					detail: `${host} is not in scripts/local-first-sinks.ts. Add it in the right mode, say it in docs/security/off-device-data.md, and if it can carry user data give it a guard.`,
				});
				continue;
			}
			if (owner.files && !fileAllowed(file, owner.files)) {
				failures.push({
					rule: "new-path",
					sink: owner.id,
					file,
					detail: `${host} reached from a file the "${owner.id}" entry does not list, which skips its guard`,
				});
			}
		}
		for (const s of sinks) {
			if (!s.patterns || fileAllowed(file, s.files)) continue;
			if (s.patterns.some((p) => p.test(text))) {
				failures.push({
					rule: "new-path",
					sink: s.id,
					file,
					detail: `reaches "${s.id}" from a file its entry does not list`,
				});
			}
		}
	}

	// 3 + 4: guards and default-path sinks
	for (const s of sinks) {
		if (s.mode === "default") {
			settle(s, { rule: "default-sink", sink: s.id, detail: `${s.what} It is on a default path.` });
		}
		for (const g of s.optIn ?? []) {
			const text = files.get(g.file);
			if (text === undefined) {
				// The file is gone: the sink may have been removed with it. Not a pass for a live sink.
				const live = [...files.values()].some((t) => (s.patterns ?? []).some((p) => p.test(t)));
				if (live)
					settle(s, {
						rule: "guard-missing",
						sink: s.id,
						file: g.file,
						detail: `guard file is missing: ${g.how}`,
					});
				else
					warnings.push(
						`${s.id}: ${g.file} not found; the sink is not reachable, so its guard is not needed`,
					);
				continue;
			}
			if (!g.mustMatch.test(text)) {
				const live =
					!s.patterns || [...files.values()].some((t) => s.patterns?.some((p) => p.test(t)));
				if (!live) {
					warnings.push(
						`${s.id}: guard in ${g.file} not found, and nothing reaches the sink any more; remove the entry or its guard`,
					);
					continue;
				}
				settle(s, {
					rule: "guard-missing",
					sink: s.id,
					file: g.file,
					detail: `${s.what} Guard missing: ${g.how}.`,
				});
			}
		}
		if (
			s.waiver &&
			!opts.noWaivers &&
			!waived.some((w) => w.sink === s.id) &&
			!failures.some((f) => f.sink === s.id)
		) {
			warnings.push(`${s.id}: waiver ${s.waiver.ref} is no longer needed; delete it`);
		}
		for (const h of s.hosts ?? []) {
			if (![...seenHosts].some((seen) => hostMatches(h, seen)))
				warnings.push(`${s.id}: ${h} is listed but not in the source; trim the list`);
		}
	}

	// 7 + 8: installs on a default path (one install, zero deps)
	for (const [file, text] of files) {
		if (INSTALL_EXCLUDED_PATH.test(file)) continue;
		const unmarked = installLines(text);
		const site = installSites.find((x) => x.file === file);
		if (unmarked.length === 0) {
			if (site)
				warnings.push(
					`${file}: listed in INSTALL_SITES (${site.mode}) but no unmarked install text is left; remove the entry`,
				);
			continue;
		}
		const first = `line ${unmarked[0].n}: ${unmarked[0].line}`;
		if (!site) {
			failures.push({
				rule: "new-install",
				file,
				detail: `${first}. A default path must not run or tell the person to run an install. Put it behind an opt-in or fallback and mark it with "local-first-gate: optin|fallback <why>", or list the file in INSTALL_SITES.`,
			});
		} else if (site.mode === "default") {
			settle(
				{ id: `install:${file}`, waiver: site.waiver },
				{ rule: "default-install", file, detail: `${site.why} (${first})` },
			);
		}
	}

	// 5: readers of Ollama's model list
	for (const [file, text] of files) {
		if (
			file !== OLLAMA_CLOUD_HELPER &&
			/api\/tags/.test(text) &&
			!/ollama-cloud/.test(text) &&
			!reviewed[file]
		) {
			failures.push({
				rule: "tags-reader",
				file,
				detail:
					"reads Ollama's /api/tags, which lists cloud models. Use dropOllamaCloud from packages/core/ollama-cloud.ts, or add the file to OLLAMA_TAG_READERS_REVIEWED with the reason it only lists or checks health.",
			});
		}
		// 6: starting the daemon ourselves
		if (/\[\s*"serve"\s*\]/.test(text) && /ollama/i.test(text) && !/OLLAMA_NO_CLOUD/.test(text)) {
			failures.push({
				rule: "serve-env",
				file,
				detail:
					"starts `ollama serve` without OLLAMA_NO_CLOUD=1, so Ollama's cloud models stay reachable",
			});
		}
	}
	for (const f of Object.keys(reviewed)) {
		if (!files.has(f) || !/api\/tags/.test(files.get(f) ?? ""))
			warnings.push(`${f} is on the reviewed /api/tags list but no longer reads it; remove it`);
	}

	return { failures, waived, warnings };
}

export function shippedFiles(root: string = ROOT): Map<string, string> {
	const r = spawnSync("git", ["ls-files", "-z"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 1 << 28,
	});
	if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
	const out = new Map<string, string>();
	for (const f of r.stdout.split("\0").filter(Boolean).sort()) {
		if (!inScope(f)) continue;
		try {
			out.set(f, readFileSync(join(root, f), "utf8"));
		} catch {}
	}
	return out;
}

function print(r: GateResult): void {
	for (const w of r.warnings) console.log(`warn  ${w}`);
	for (const f of r.waived) console.log(`known ${f.sink ?? ""} ${f.file ?? ""}: ${f.detail}`);
	for (const f of r.failures)
		console.log(
			`FAIL  [${f.rule}]${f.sink ? ` ${f.sink}` : ""}${f.file ? ` ${f.file}` : ""}: ${f.detail}`,
		);
	console.log(
		`\nlocal-first gate: ${r.failures.length} failing, ${r.waived.length} known, ${r.warnings.length} warnings`,
	);
}

if (import.meta.main) {
	const rootArg = process.argv.indexOf("--root");
	const root = rootArg > 0 ? process.argv[rootArg + 1] : ROOT;
	const result = runGate(shippedFiles(root), { noWaivers: process.argv.includes("--no-waivers") });
	if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
	else print(result);
	process.exit(result.failures.length ? 1 : 0);
}
