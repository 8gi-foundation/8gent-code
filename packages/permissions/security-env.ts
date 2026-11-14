/**
 * The startup security env snapshot and realpathLoose, in a leaf module.
 *
 * Moved out of run-command-sandbox.ts so goal-state-hmac.ts (and through it
 * the Table store) can read the key path without loading the run_command
 * sandbox, which pulls in node:child_process and the seatbelt/landlock
 * profiles. Behaviour is unchanged: the snapshot is still taken once, at
 * module load, and run-command-sandbox.ts re-exports every name from here.
 *
 * This module must import nothing but node builtins and ../core/home.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================
// Security env snapshot
// ============================================

/** Env keys that decide whether and where the boundary applies. */
export const SECURITY_ENV_KEYS = [
	"EIGHT_SEATBELT",
	// The OS read boundary (#4890): "1" turns it on. A .env may turn it on, never off.
	"EIGHT_OS_READ_BOUNDARY",
	"EIGHT_DATA_DIR",
	// Where providers.json is read from (and so where a provider's key is sent, #4622).
	"EIGHT_PROVIDERS_SETTINGS_PATH",
	"EIGHT_HOME",
	"EIGHT_FAKE_HOME",
	"HOME",
	"USERPROFILE",
	"NODE_ENV",
	"BUN_ENV",
	// Where post_message and /telegram setup send the bot key (#4594): a .env must not move it.
	"EIGHT_TG_API_BASE",
] as const;
export type SecurityKey = (typeof SECURITY_ENV_KEYS)[number];

export interface SecurityEnv {
	values: Partial<Record<SecurityKey, string>>;
	/** Keys declared in a .env file, so ignored. */
	ignored: SecurityKey[];
}

/**
 * The .env files that belong to a PROJECT: Bun's cwd files and the repo root's.
 * A cloned repo controls these, so nothing in them is the user's choice (#4622).
 */
export function projectDotenvCandidates(cwd: string = process.cwd()): string[] {
	const names = [".env", ".env.local"];
	for (const mode of ["development", "production", "test"])
		names.push(`.env.${mode}`, `.env.${mode}.local`);
	return [...names.map((n) => path.join(cwd, n)), path.resolve(import.meta.dirname, "../../.env")];
}

/** The user's own shell-style env files under ~/.8gent. */
export function userDotenvCandidates(home: string = os.homedir()): string[] {
	return [
		path.join(home, ".8gent", ".env"),
		// The keys file is shell-style too: an EIGHT_DATA_DIR in it is not trusted env (#4132, 8SO).
		path.join(home, ".8gent", "keys.env"),
	];
}

/** The .env files Bun (cwd, by NODE_ENV) or the TUI loader could have read. */
export function dotenvCandidates(
	cwd: string = process.cwd(),
	home: string = os.homedir(),
): string[] {
	return [...projectDotenvCandidates(cwd), ...userDotenvCandidates(home)];
}

/** Keys declared (KEY=..., export KEY=..., any value form) in the given dotenv files. */
export function dotenvDeclaredKeys(files: string[]): Set<string> {
	const keys = new Set<string>();
	for (const f of files) {
		let text: string;
		try {
			// A leading BOM would hide the first key from the match; Bun still loads it.
			text = fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "");
		} catch {
			continue;
		}
		for (const m of text.matchAll(/^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[=:]/gm))
			keys.add(m[1] as string);
	}
	return keys;
}

/**
 * Pure: drop each security key any .env file declares, whatever the value.
 * EIGHT_SEATBELT=require and EIGHT_OS_READ_BOUNDARY=1 are kept regardless:
 * dropping either could only weaken.
 */
export function snapshotSecurityEnv(
	env: Readonly<Partial<Record<SecurityKey, string>>>,
	declared: Set<string>,
): SecurityEnv {
	const values: SecurityEnv["values"] = {};
	const ignored: SecurityKey[] = [];
	// Env names are case-insensitive on Windows: compare upper-cased (#4622).
	const upper = new Set([...declared].map((d) => d.toUpperCase()));
	for (const k of SECURITY_ENV_KEYS) {
		const v = env[k];
		if (v === undefined || v === "") continue;
		const stricter =
			(k === "EIGHT_SEATBELT" && v === "require") || (k === "EIGHT_OS_READ_BOUNDARY" && v === "1");
		if (upper.has(k) && !stricter) ignored.push(k);
		else values[k] = v;
	}
	return { values, ignored };
}

function takeSnapshot(): SecurityEnv {
	return snapshotSecurityEnv(process.env, dotenvDeclaredKeys(dotenvCandidates()));
}

// Taken at module load: before the TUI's loadEnvFile() runs (app.tsx imports
// this module's importers first), so nothing it sets can steer the boundary.
let securityEnv: SecurityEnv = takeSnapshot();
// Every key any .env file declares, read once at load for the same reason (#4622).
let dotenvDeclaredAtLoad: Set<string> = dotenvDeclaredKeys(dotenvCandidates());
// Only the project's files (cwd, repo root): the user's ~/.8gent/keys.env is theirs.
let projectDeclaredAtLoad: Set<string> = dotenvDeclaredKeys(projectDotenvCandidates());

/**
 * The names the TUI's project .env loader may copy into process.env: a provider
 * key variable (a registry entry's apiKeyEnv, or any NAME_API_KEY). Everything
 * else is dropped. A denylist missed HTTPS_PROXY and NODE_TLS_REJECT_UNAUTHORIZED,
 * which let a cloned repo's .env route the Bearer key through its own proxy (#4622).
 */
export function dotenvKeyIsAllowed(key: string, registryKeyEnvs: ReadonlySet<string>): boolean {
	return registryKeyEnvs.has(key) || /^[A-Z0-9_]+_API_KEY$/.test(key);
}

/** Variables that decide where a request goes or whether its TLS is checked. */
const NETWORK_ENV_KEYS = [
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NODE_TLS_REJECT_UNAUTHORIZED",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
] as const;

/** Also hostile when a project .env sets them: they change how bun or node starts and runs. */
const isHostileNetworkName = (up: string): boolean =>
	(NETWORK_ENV_KEYS as readonly string[]).includes(up) ||
	up === "NODE_OPTIONS" ||
	up.startsWith("BUN_");

/**
 * Pure: the process.env names to delete because a PROJECT .env declared them.
 * Bun loads the cwd .env before any code runs and its fetch reads these at call
 * time, so they are removed here, once, at load (#4622). By NAME, case-insensitive,
 * whatever the value: Bun strips inline comments and expands $VAR, so no parse of
 * the file's value can say what Bun actually set.
 */
export function hostileNetworkEnvNames(
	envNames: Iterable<string>,
	projectDeclared: ReadonlySet<string>,
): string[] {
	const declared = new Set([...projectDeclared].map((k) => k.toUpperCase()));
	const out: string[] = [];
	for (const name of envNames) {
		const up = name.toUpperCase();
		if (isHostileNetworkName(up) && declared.has(up)) out.push(name);
	}
	return out;
}

function dropHostileNetworkEnv(): string[] {
	const names = hostileNetworkEnvNames(Object.keys(process.env), projectDeclaredAtLoad);
	for (const n of names) Reflect.deleteProperty(process.env, n);
	// Names only, never values.
	if (names.length > 0)
		process.stderr.write(
			`8gent: ignored ${names.join(", ")} because this folder's .env file sets them (they can change where requests go). If you set one yourself, your own value was cleared too: fix the .env file and export it again.\n`,
		);
	return names;
}
/** Names removed from process.env at load because a project .env set them. */
export const droppedNetworkEnv: string[] = dropHostileNetworkEnv();

/** The proxy for a URL as it stood after that load-time cleanup, or undefined. */
const loadTimeProxy: Record<"http:" | "https:", string | undefined> = {
	"http:": process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY,
	"https:":
		process.env.HTTPS_PROXY ||
		process.env.https_proxy ||
		process.env.ALL_PROXY ||
		process.env.all_proxy,
};
export function trustedProxyFor(url: string): string | undefined {
	try {
		const proto = new URL(url).protocol;
		return proto === "https:" || proto === "http:" ? loadTimeProxy[proto] : undefined;
	} catch {
		return undefined;
	}
}

/**
 * An endpoint override from the environment, dropped when a PROJECT .env declares
 * it (same rule as the security keys, #4615): a value a repo's .env could have
 * set is not the user's choice. One the user wrote in their own ~/.8gent/keys.env
 * is honoured. Used for MINIMAX_BASE_URL, LMSTUDIO_BASE_URL and APFEL_BASE_URL.
 */
export function trustedEnvValue(
	key: string,
	env: Readonly<Record<string, string | undefined>> = process.env,
	projectDeclared: ReadonlySet<string> = projectDeclaredAtLoad,
): string | undefined {
	const v = env[key];
	if (!v) return undefined;
	const up = key.toUpperCase();
	for (const d of projectDeclared) if (d.toUpperCase() === up) return undefined;
	return v;
}

/**
 * A security key's value: the load-time snapshot (which drops .env-declared
 * keys). In test mode the live env is read, as fakeHome() does.
 */
export function trustedSecurityValue(key: SecurityKey): string | undefined {
	if (isTestMode(securityEnv.values)) return process.env[key] || undefined;
	return securityEnv.values[key];
}

export function securityEnvSnapshot(): SecurityEnv {
	return securityEnv;
}

/** Pure: test mode comes only from a NODE_ENV/BUN_ENV that a .env file did not set. */
export function isTestMode(values: SecurityEnv["values"]): boolean {
	return values.NODE_ENV === "test" || values.BUN_ENV === "test";
}

function inTestMode(): boolean {
	return isTestMode(securityEnv.values);
}

/** Tests only: re-read the env after changing it. A no-op outside test mode. */
export function refreshSecurityEnvForTests(): void {
	if (inTestMode()) {
		securityEnv = takeSnapshot();
		dotenvDeclaredAtLoad = dotenvDeclaredKeys(dotenvCandidates());
		projectDeclaredAtLoad = dotenvDeclaredKeys(projectDotenvCandidates());
	}
}

/** EIGHT_FAKE_HOME is a test hook: honoured only in test mode, read live there. */
export function fakeHome(): string | undefined {
	return inTestMode() ? process.env.EIGHT_FAKE_HOME || undefined : undefined;
}

/**
 * Resolve a path that may not exist yet: realpath the deepest existing
 * ancestor and append the rest. The kernel matches real paths, so a symlinked
 * HOME or ~/.8gent is only covered when its real spelling is denied too.
 */
export function realpathLoose(p: string): string {
	const abs = path.resolve(p);
	const tail: string[] = [];
	let cur = abs;
	for (;;) {
		try {
			const real = fs.realpathSync(cur);
			return tail.length ? path.join(real, ...tail.reverse()) : real;
		} catch {
			const parent = path.dirname(cur);
			if (parent === cur) return abs;
			tail.push(path.basename(cur));
			cur = parent;
		}
	}
}
