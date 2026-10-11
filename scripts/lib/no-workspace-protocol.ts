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

/** Root manifest plus every package.json one level under the root "workspaces" globs (dir/*). */
export function workspaceManifests(root: string): string[] {
	const rootManifest = join(root, "package.json");
	const files = [rootManifest];
	const pkg = JSON.parse(readFileSync(rootManifest, "utf8"));
	const globs: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages ?? [];
	for (const g of globs) {
		const base = g.replace(/\/\*+$/, "");
		const dir = join(root, base);
		if (g.endsWith("*") && existsSync(dir)) {
			for (const e of readdirSync(dir, { withFileTypes: true })) {
				const f = join(dir, e.name, "package.json");
				if (e.isDirectory() && existsSync(f)) files.push(f);
			}
		} else if (existsSync(join(dir, "package.json"))) files.push(join(dir, "package.json"));
	}
	return files;
}

export function scanRepo(root: string): Offence[] {
	return workspaceManifests(root).flatMap((f) =>
		findWorkspaceSpecifiers(JSON.parse(readFileSync(f, "utf8")), f.slice(root.length + 1)),
	);
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
