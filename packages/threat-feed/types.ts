export type Ecosystem = "npm" | "PyPI" | "Go" | "crates.io";

export interface Dep {
	ecosystem: Ecosystem;
	name: string;
	version: string;
	/** Lockfile paths inside the repo that pinned this version. */
	files: string[];
	/** true: only reached through devDependencies. false: reachable from production deps. undefined: lockfile cannot say. */
	dev?: boolean;
}

export interface RepoInventory {
	repo: string;
	deps: Dep[];
	lockfiles: string[];
	/** Reasons a lockfile or the whole repo could not be read. Never silently dropped. */
	skipped: string[];
}

export interface OsvVuln {
	id: string;
	aliases?: string[];
	summary?: string;
	database_specific?: { severity?: string };
	severity?: { type: string; score: string }[];
	affected?: {
		package?: { ecosystem: string; name: string };
		ranges?: { type: string; events: Record<string, string>[] }[];
		versions?: string[];
	}[];
}

export interface KevEntry {
	cveID: string;
	dateAdded?: string;
	dueDate?: string;
	knownRansomwareCampaignUse?: string;
}

export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "UNKNOWN";

export interface Hit {
	repo: string;
	package: string;
	ecosystem: Ecosystem;
	currentVersion: string;
	fixedVersion: string | null;
	/** OSV listed a fix but it failed the token check, so it is not printed. */
	fixedVersionInvalid: boolean;
	severity: Severity;
	cvss: number | null;
	onKev: boolean;
	kevCves: string[];
	advisoryId: string;
	aliases: string[];
	advisoryUrl: string;
	summary: string;
	files: string[];
	/** true: dev-only dependency, false: production, null: lockfile cannot say. */
	devOnly: boolean | null;
}
