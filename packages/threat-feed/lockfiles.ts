import type { Dep, Ecosystem } from "./types";

type Raw = { ecosystem: Ecosystem; name: string; version: string };

/** Basenames we read. bun.lockb is binary and handled by the caller as a skip. */
export const LOCKFILE_NAMES = [
	"bun.lock",
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"poetry.lock",
	"go.sum",
	"Cargo.lock",
];

export function isLockfilePath(p: string): boolean {
	const parts = p.split("/");
	const base = parts[parts.length - 1];
	if (parts.some((s) => ["node_modules", "fixtures", "__fixtures__", "testdata"].includes(s))) {
		return false;
	}
	return LOCKFILE_NAMES.includes(base) || /^requirements[^/]*\.txt$/.test(base);
}

const NON_REGISTRY = /^(workspace|file|link|github|git|git\+|http|https|portal|patch):/;

function splitNameVersion(spec: string): { name: string; version: string } | null {
	const at = spec.lastIndexOf("@");
	if (at <= 0) return null;
	return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export function parseBunLock(text: string): Raw[] {
	// bun.lock is JSONC: trailing commas. Strip them outside of strings.
	let out = "";
	let inStr = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			out += c;
			if (c === "\\") out += text[++i] ?? "";
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') {
			inStr = true;
			out += c;
		} else if (c === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] !== "}" && text[j] !== "]") out += c;
		} else out += c;
	}
	const doc = JSON.parse(out) as { packages?: Record<string, unknown[]> };
	const res: Raw[] = [];
	for (const entry of Object.values(doc.packages ?? {})) {
		const spec = typeof entry?.[0] === "string" ? (entry[0] as string) : "";
		const nv = splitNameVersion(spec);
		if (!nv || NON_REGISTRY.test(nv.version) || !/^\d/.test(nv.version)) continue;
		res.push({ ecosystem: "npm", ...nv });
	}
	return res;
}

export function parsePackageLock(text: string): Raw[] {
	const doc = JSON.parse(text) as {
		packages?: Record<string, { version?: string; link?: boolean }>;
		dependencies?: Record<string, { version?: string; dependencies?: unknown }>;
	};
	const res: Raw[] = [];
	if (doc.packages) {
		for (const [path, p] of Object.entries(doc.packages)) {
			const idx = path.lastIndexOf("node_modules/");
			if (idx < 0 || p.link || !p.version) continue;
			res.push({
				ecosystem: "npm",
				name: path.slice(idx + "node_modules/".length),
				version: p.version,
			});
		}
		return res;
	}
	const walk = (deps: Record<string, { version?: string; dependencies?: unknown }> | undefined) => {
		for (const [name, d] of Object.entries(deps ?? {})) {
			if (d.version && /^\d/.test(d.version))
				res.push({ ecosystem: "npm", name, version: d.version });
			walk(d.dependencies as typeof deps);
		}
	};
	walk(doc.dependencies);
	return res;
}

export function parsePnpmLock(text: string): Raw[] {
	const res: Raw[] = [];
	let inPackages = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\S/.test(line)) {
			inPackages = /^packages:\s*$/.test(line);
			continue;
		}
		if (!inPackages) continue;
		const m = line.match(/^ {2}(['"]?)([^\s'"][^'"]*?)\1:\s*(\{.*)?$/);
		if (!m) continue;
		let key = m[2].replace(/^\//, "");
		key = key.replace(/\(.*$/, ""); // v6+/v9 peer suffix
		let nv = splitNameVersion(key);
		if (!nv || !/^\d/.test(nv.version)) {
			// v5: /name/1.2.3 or /name/1.2.3_peer@x
			const m5 = key.match(/^(.+)\/(\d[^/_]*)(_.*)?$/);
			nv = m5 ? { name: m5[1], version: m5[2] } : null;
		}
		if (!nv || !/^\d/.test(nv.version)) continue;
		nv.version = nv.version.replace(/_.*$/, "");
		res.push({ ecosystem: "npm", ...nv });
	}
	return res;
}

export function parseRequirements(text: string): Raw[] {
	const res: Raw[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw
			.replace(/\s+#.*$/, "")
			.replace(/^\s*#.*$/, "")
			.trim();
		const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)/);
		if (m)
			res.push({
				ecosystem: "PyPI",
				name: m[1].toLowerCase().replace(/[._]+/g, "-"),
				version: m[3],
			});
	}
	return res;
}

function parseTomlPackages(text: string, ecosystem: Ecosystem, requireSource: boolean): Raw[] {
	const res: Raw[] = [];
	for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
		const head = block.split(/^\[/m)[0];
		const name = head.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
		const version = head.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
		if (!name || !version) continue;
		if (requireSource && !/^source\s*=/m.test(head)) continue; // workspace member, not a dependency
		res.push({
			ecosystem,
			name: ecosystem === "PyPI" ? name.toLowerCase().replace(/[._]+/g, "-") : name,
			version,
		});
	}
	return res;
}

export const parsePoetryLock = (t: string) => parseTomlPackages(t, "PyPI", false);
export const parseCargoLock = (t: string) => parseTomlPackages(t, "crates.io", true);

export function parseGoSum(text: string): Raw[] {
	const res: Raw[] = [];
	for (const line of text.split(/\r?\n/)) {
		const [mod, ver] = line.trim().split(/\s+/);
		if (!mod || !ver || ver.endsWith("/go.mod")) continue;
		res.push({ ecosystem: "Go", name: mod, version: ver.replace(/^v/, "") });
	}
	return res;
}

/** Returns null for a basename we cannot parse as text. Throws on malformed content. */
export function parseLockfile(path: string, text: string): Raw[] | null {
	const base = path.split("/").pop() ?? path;
	if (base === "bun.lock") return parseBunLock(text);
	if (base === "package-lock.json") return parsePackageLock(text);
	if (base === "pnpm-lock.yaml") return parsePnpmLock(text);
	if (base === "poetry.lock") return parsePoetryLock(text);
	if (base === "go.sum") return parseGoSum(text);
	if (base === "Cargo.lock") return parseCargoLock(text);
	if (/^requirements[^/]*\.txt$/.test(base)) return parseRequirements(text);
	return null;
}

/** Merge raw entries from many lockfiles into unique deps, remembering which files pinned each. */
export function mergeDeps(perFile: { path: string; raws: Raw[] }[]): Dep[] {
	const map = new Map<string, Dep>();
	for (const { path, raws } of perFile) {
		for (const r of raws) {
			const k = `${r.ecosystem}\0${r.name}\0${r.version}`;
			const d = map.get(k) ?? { ...r, files: [] };
			if (!d.files.includes(path)) d.files.push(path);
			map.set(k, d);
		}
	}
	return [...map.values()].sort(
		(a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
	);
}
