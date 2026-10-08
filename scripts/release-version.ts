#!/usr/bin/env bun
/**
 * Release version tooling for the Release PR workflow (#3658).
 *
 *   bun scripts/release-version.ts current
 *       Print the version in package.json.
 *
 *   bun scripts/release-version.ts next [--bump auto|patch|minor|major]
 *       Print the next version: max(package.json, highest v* tag in its major
 *       line), bumped, then stepped past any tag that already exists. With
 *       --bump auto (the default) the level comes from [bump:major] or
 *       [bump:minor] in the PR titles and bodies merged since the previous
 *       release; otherwise it is a patch.
 *
 *   bun scripts/release-version.ts apply <version>
 *       Write <version> into package.json, bin/8gent.ts and the README badge.
 *
 *   bun scripts/release-version.ts commit <version>
 *       Print the first-parent commit on HEAD's history where package.json
 *       first carried <version>: the commit a release tag belongs on.
 *
 * Logic and tests: scripts/lib/release-version.ts.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import {
	bumpFromMarkers,
	nextVersion,
	parseBump,
	parseSemver,
	releaseBase,
	setBinVersion,
	setPackageVersion,
	setReadmeBadge,
} from "./lib/release-version";

function git(args: string[], ok: number[] = [0]): string {
	const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	if (!ok.includes(r.status ?? -1))
		throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
	return r.stdout;
}

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	if (i === -1) return undefined;
	const v = process.argv[i + 1];
	if (!v || v.startsWith("--")) throw new Error(`--${name} needs a value`);
	return v;
}

function currentVersion(): string {
	const v = JSON.parse(readFileSync("package.json", "utf8")).version;
	if (typeof v !== "string" || !parseSemver(v))
		throw new Error(`package.json version is not X.Y.Z: ${v}`);
	return v;
}

function releaseTags(): string[] {
	return git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
}

function tagExists(tag: string): boolean {
	const r = spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`], {
		encoding: "utf8",
	});
	return r.status === 0;
}

/** Bump level from the merged PR titles and bodies since the previous release. */
function bumpSinceBase(base: string): "patch" | "minor" | "major" {
	const tag = `v${base}`;
	if (!tagExists(tag)) return "patch";
	// Release tags can sit on bump commits that never reached main (that is how
	// #3658 happened), so the range starts at the tag's merge-base with HEAD.
	const from = git(["merge-base", `${tag}^{commit}`, "HEAD"]).trim();
	return bumpFromMarkers(git(["log", "--first-parent", "--format=%s%n%b", `${from}..HEAD`]));
}

function cmdNext(): void {
	const current = currentVersion();
	const tags = releaseTags();
	const bump = parseBump(arg("bump")) ?? bumpSinceBase(releaseBase(current, tags));
	process.stdout.write(`${nextVersion(current, tags, bump)}\n`);
}

function cmdApply(version: string): void {
	const edits: Array<[string, (text: string) => string, boolean]> = [
		["package.json", (t) => setPackageVersion(t, version), true],
		["bin/8gent.ts", (t) => setBinVersion(t, version), true],
		["README.md", (t) => setReadmeBadge(t, version), false],
	];
	for (const [file, edit, required] of edits) {
		const before = readFileSync(file, "utf8");
		const after = edit(before);
		if (after === before) {
			if (required) throw new Error(`${file}: already at ${version}, nothing to apply`);
			console.error(`${file}: no version badge found, unchanged`);
			continue;
		}
		writeFileSync(file, after);
		console.error(`${file}: version ${version}`);
	}
}

/** Oldest first-parent commit (walking back from HEAD) whose package.json has `version`. */
function cmdCommit(version: string): void {
	let found: string | null = null;
	for (const sha of git(["log", "--first-parent", "--format=%H", "--", "package.json"]).split(
		"\n",
	)) {
		if (!sha) continue;
		const shown = spawnSync("git", ["show", `${sha}:package.json`], { encoding: "utf8" });
		if (shown.status !== 0) break;
		let v: unknown;
		try {
			v = JSON.parse(shown.stdout).version;
		} catch {
			break;
		}
		if (v !== version) break;
		found = sha;
	}
	if (!found) throw new Error(`no first-parent commit on HEAD has package.json version ${version}`);
	process.stdout.write(`${found}\n`);
}

function main(): void {
	const [cmd, value] = process.argv.slice(2);
	switch (cmd) {
		case "current":
			process.stdout.write(`${currentVersion()}\n`);
			return;
		case "next":
			cmdNext();
			return;
		case "apply":
		case "commit": {
			if (!value || !parseSemver(value) || value.startsWith("v")) {
				throw new Error(`${cmd} needs a version X.Y.Z, not ${JSON.stringify(value)}`);
			}
			if (cmd === "apply") cmdApply(value);
			else cmdCommit(value);
			return;
		}
		default:
			throw new Error(
				"usage: release-version.ts current | next [--bump auto|patch|minor|major] | apply X.Y.Z | commit X.Y.Z",
			);
	}
}

try {
	main();
} catch (e) {
	console.error(`release-version: ${(e as Error).message}`);
	process.exit(1);
}
