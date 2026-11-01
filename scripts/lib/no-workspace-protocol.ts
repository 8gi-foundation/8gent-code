/**
 * No `workspace:` specifiers in any manifest (npm cannot install them).
 *
 * npm understands the root "workspaces" array but throws EUNSUPPORTEDPROTOCOL on
 * "workspace:*" in a dependency. Bun links a plain "*" to the local workspace
 * package of that name just the same, so manifests use "*" and both installers work.
 *
 * Usage:
 *   bun scripts/lib/no-workspace-protocol.ts            scan the repo's manifests
 *   bun scripts/lib/no-workspace-protocol.ts a.tgz ...  also scan the package.json inside each tarball
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
	"overrides",
	"resolutions",
] as const;

export interface Offence {
	file: string;
	field: string;
	name: string;
	spec: string;
}

function walk(value: unknown, field: string, file: string, out: Offence[]): void {
	if (!value || typeof value !== "object") return;
	for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
		if (typeof spec === "string") {
			if (spec.startsWith("workspace:")) out.push({ file, field, name, spec });
		} else walk(spec, field, file, out);
	}
}

export function findWorkspaceSpecifiers(manifest: Record<string, unknown>, file: string): Offence[] {
	const out: Offence[] = [];
	for (const field of DEP_FIELDS) walk(manifest[field], field, file, out);
	return out;
}

function expand(base: string, segs: string[]): string[] {
	if (segs.length === 0) return [base];
	const [seg, ...rest] = segs;
	if (seg === "**") {
		const out = expand(base, rest);
		for (const d of subdirs(base)) out.push(...expand(join(base, d), segs));
		return out;
	}
	if (seg.includes("*")) {
		const re = new RegExp(`^${seg.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
		return subdirs(base).filter((d) => re.test(d)).flatMap((d) => expand(join(base, d), rest));
	}
	return expand(join(base, seg), rest);
}

function subdirs(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
		.map((e) => e.name);
}

/** Root manifest plus every package.json matched by the root "workspaces" globs (nested and ** included). */
export function workspaceManifests(root: string): string[] {
	const rootManifest = join(root, "package.json");
	const pkg = JSON.parse(readFileSync(rootManifest, "utf8"));
	const globs: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
	const files = new Set([rootManifest]);
	for (const g of globs) {
		for (const dir of expand(root, g.split("/").filter(Boolean))) {
			const f = join(dir, "package.json");
			if (existsSync(f)) files.add(f);
		}
	}
	return [...files];
}

/** bun.lock must not record workspace: either; it makes a lockfile-driven install differ from npm's. */
export function scanLockfile(root: string): Offence[] {
	const f = join(root, "bun.lock");
	if (!existsSync(f)) return [];
	const out: Offence[] = [];
	readFileSync(f, "utf8").split("\n").forEach((line, i) => {
		const m = /"([^"]+)":\s*"(workspace:[^"]*)"/.exec(line);
		if (m) out.push({ file: `bun.lock:${i + 1}`, field: "lock", name: m[1], spec: m[2] });
	});
	return out;
}

/** Internal @8gent/* dependencies must pin the workspace package's exact current version. */
export function internalPinMismatches(root: string): Offence[] {
	const manifests = workspaceManifests(root).map((f) => ({ f, j: JSON.parse(readFileSync(f, "utf8")) }));
	const versions = new Map<string, string>(manifests.filter((m) => m.j.name).map((m) => [m.j.name, m.j.version]));
	const out: Offence[] = [];
	for (const { f, j } of manifests)
		for (const field of ["dependencies", "devDependencies", "optionalDependencies"] as const)
			for (const [name, spec] of Object.entries((j[field] ?? {}) as Record<string, string>)) {
				const v = versions.get(name);
				if (v && spec !== v) out.push({ file: f.slice(root.length + 1), field, name, spec: `${spec} (workspace is ${v})` });
			}
	return out;
}

/** Rewrite internal pins in one manifest's text to the workspaces' current versions (keeps formatting). */
export function syncInternalPins(text: string, versions: Map<string, string>): string {
	return text.replace(/("(@8gent\/[^"]+)":\s*")([^"]*)(")/g, (m, a, name, _old, d) =>
		versions.has(name) ? `${a}${versions.get(name)}${d}` : m,
	);
}

export function workspaceVersions(root: string): Map<string, string> {
	return new Map(
		workspaceManifests(root)
			.map((f) => JSON.parse(readFileSync(f, "utf8")))
			.filter((j) => j.name)
			.map((j) => [j.name as string, j.version as string]),
	);
}

export function scanRepo(root: string): Offence[] {
	return [...scanLockfile(root), ...internalPinMismatches(root), ...workspaceManifests(root).flatMap((f) =>
		findWorkspaceSpecifiers(JSON.parse(readFileSync(f, "utf8")), f.slice(root.length + 1)),
	)];
}

export function scanTarball(tgz: string): Offence[] {
	const r = spawnSync("tar", ["-xzOf", tgz, "package/package.json"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`cannot read package/package.json from ${tgz}: ${r.stderr}`);
	return findWorkspaceSpecifiers(JSON.parse(r.stdout), `${tgz}:package/package.json`);
}

if (import.meta.main) {
	const root = resolve(import.meta.dir, "..", "..");
	const offences = [...scanRepo(root), ...process.argv.slice(2).flatMap(scanTarball)];
	for (const o of offences) console.error(`${o.file}: ${o.field}.${o.name} = "${o.spec}"`);
	if (offences.length) {
		console.error(`${offences.length} workspace: specifier(s). Use "*" so npm install works.`);
		process.exit(1);
	}
	console.log("no workspace: specifiers");
}
