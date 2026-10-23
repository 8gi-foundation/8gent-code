import type { Dep, Hit, KevEntry, OsvVuln, Severity } from "./types";

/** Lenient dotted-numeric compare, enough to order fixed versions. Returns NaN if either has no digits. */
export function compareVersions(a: string, b: string): number {
	const seg = (v: string) =>
		v
			.replace(/^v/, "")
			.split(/[.+-]/)
			.map((s) => Number.parseInt(s, 10));
	const x = seg(a);
	const y = seg(b);
	if (x.every(Number.isNaN) || y.every(Number.isNaN)) return Number.NaN;
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const p = Number.isNaN(x[i] ?? 0) ? 0 : (x[i] ?? 0);
		const q = Number.isNaN(y[i] ?? 0) ? 0 : (y[i] ?? 0);
		if (p !== q) return p < q ? -1 : 1;
	}
	return 0;
}

const W = {
	AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
	AC: { L: 0.77, H: 0.44 },
	UI: { N: 0.85, R: 0.62 },
	CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

const roundUp = (n: number) => {
	const i = Math.round(n * 100000);
	return i % 10000 === 0 ? i / 100000 : (Math.floor(i / 10000) + 1) / 10;
};

/** CVSS v3.x base score from a vector string. Null for anything else (v2, v4, malformed). */
export function cvss3Base(vector: string): number | null {
	if (!/^CVSS:3\.[01]\//.test(vector)) return null;
	const m = Object.fromEntries(
		vector
			.split("/")
			.slice(1)
			.map((p) => p.split(":")),
	);
	const scope = m.S;
	const av = W.AV[m.AV as keyof typeof W.AV];
	const ac = W.AC[m.AC as keyof typeof W.AC];
	const ui = W.UI[m.UI as keyof typeof W.UI];
	const c = W.CIA[m.C as keyof typeof W.CIA];
	const i = W.CIA[m.I as keyof typeof W.CIA];
	const a = W.CIA[m.A as keyof typeof W.CIA];
	const pr = { N: 0.85, L: scope === "C" ? 0.68 : 0.62, H: scope === "C" ? 0.5 : 0.27 }[
		m.PR as "N" | "L" | "H"
	];
	if ([av, ac, ui, c, i, a, pr].some((v) => v === undefined) || (scope !== "U" && scope !== "C"))
		return null;
	const iss = 1 - (1 - c) * (1 - i) * (1 - a);
	const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
	if (impact <= 0) return 0;
	const expl = 8.22 * av * ac * pr * ui;
	return scope === "U"
		? roundUp(Math.min(impact + expl, 10))
		: roundUp(Math.min(1.08 * (impact + expl), 10));
}

export function bucket(score: number): Severity {
	if (score >= 9) return "CRITICAL";
	if (score >= 7) return "HIGH";
	if (score >= 4) return "MEDIUM";
	return score > 0 ? "LOW" : "UNKNOWN";
}

export function severityOf(v: OsvVuln): { severity: Severity; cvss: number | null } {
	let cvss: number | null = null;
	for (const s of v.severity ?? []) {
		const sc = s.type === "CVSS_V3" ? cvss3Base(s.score) : null;
		if (sc !== null) cvss = Math.max(cvss ?? 0, sc);
	}
	if (cvss !== null) return { severity: bucket(cvss), cvss };
	const label = v.database_specific?.severity?.toUpperCase();
	if (label === "MODERATE") return { severity: "MEDIUM", cvss: null };
	if (label === "CRITICAL" || label === "HIGH" || label === "MEDIUM" || label === "LOW") {
		return { severity: label, cvss: null };
	}
	return { severity: "UNKNOWN", cvss: null };
}

function fixCandidates(v: OsvVuln, dep: Dep): string[] {
	const fixes: string[] = [];
	for (const af of v.affected ?? []) {
		if (
			af.package &&
			(af.package.ecosystem !== dep.ecosystem ||
				af.package.name.toLowerCase() !== dep.name.toLowerCase())
		) {
			continue;
		}
		for (const r of af.ranges ?? []) {
			for (const e of r.events) {
				const f = e.fixed;
				if (typeof f === "string") fixes.push(f.replace(/^v/, ""));
			}
		}
	}
	return fixes;
}

/** Smallest fixed version above the current one, from OSV ranges of the matching package. Values that fail the token check are never returned. */
export function fixedVersionFor(v: OsvVuln, dep: Dep): string | null {
	const above = fixCandidates(v, dep).filter(
		(f) => isToken(f) && compareVersions(f, dep.version) > 0,
	);
	if (above.length) return above.sort(compareVersions).at(0) ?? null;
	return null;
}

/** True when OSV listed a fix for this package that we refuse to print. */
export const hasInvalidFix = (v: OsvVuln, dep: Dep): boolean =>
	fixCandidates(v, dep).some((f) => !isToken(f));

/** Strict token for anything a third party controls and we print: ids, aliases, CVEs, versions. */
export const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,63}$/;
/** Package names and lockfile paths need "/" and "@" (scoped npm, Go modules, nested paths). No whitespace, backticks or markup. */
export const NAME_RE = /^[A-Za-z0-9@_.][A-Za-z0-9@_.\/:+~-]{0,199}$/;
export const isToken = (s: unknown): s is string => typeof s === "string" && TOKEN_RE.test(s);
export const isName = (s: unknown): s is string => typeof s === "string" && NAME_RE.test(s);

export function advisoryUrl(id: string): string {
	return `https://osv.dev/vulnerability/${id}`;
}

export interface MatchInput {
	repo: string;
	deps: Dep[];
	/** OSV vuln ids reported for each dep key, as returned by querybatch. */
	idsByDep: Map<string, string[]>;
	vulns: Map<string, OsvVuln>;
	kev: Map<string, KevEntry>;
}

export const depKey = (d: Pick<Dep, "ecosystem" | "name" | "version">) =>
	`${d.ecosystem}\0${d.name}\0${d.version}`;

export function matchRepo(input: MatchInput): Hit[] {
	const hits: Hit[] = [];
	for (const dep of input.deps) {
		// A dep we cannot print safely is dropped, never rewritten.
		if (!isName(dep.name) || !isToken(dep.version)) continue;
		const files = dep.files.filter(isName);
		for (const id of input.idsByDep.get(depKey(dep)) ?? []) {
			const v = input.vulns.get(id);
			if (!v || !isToken(id)) continue;
			const aliases = (v.aliases ?? []).filter(isToken);
			const kevCves = [id, ...aliases].filter((x) => input.kev.has(x));
			const sev = severityOf(v);
			const fixed = fixedVersionFor(v, dep);
			hits.push({
				repo: input.repo,
				package: dep.name,
				ecosystem: dep.ecosystem,
				currentVersion: dep.version,
				fixedVersion: fixed,
				fixedVersionInvalid: fixed === null && hasInvalidFix(v, dep),
				severity: sev.severity,
				cvss: sev.cvss,
				onKev: kevCves.length > 0,
				kevCves,
				advisoryId: id,
				aliases,
				advisoryUrl: advisoryUrl(id),
				summary: (v.summary ?? "").slice(0, 200),
				files,
				devOnly: dep.dev ?? null,
			});
		}
	}
	return hits;
}

const RANK: Record<Severity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

/** KEV first, then severity, then CVSS, then stable by repo/package. */
export function rankHits(hits: Hit[]): Hit[] {
	return [...hits].sort(
		(a, b) =>
			Number(b.onKev) - Number(a.onKev) ||
			RANK[b.severity] - RANK[a.severity] ||
			(b.cvss ?? 0) - (a.cvss ?? 0) ||
			a.repo.localeCompare(b.repo) ||
			a.package.localeCompare(b.package) ||
			a.advisoryId.localeCompare(b.advisoryId),
	);
}
