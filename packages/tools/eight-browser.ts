/**
 * 8gent Code - 8gent Browser driver for browser_open / browser_state / browser_task (#3589).
 *
 * Talks to 8gent Browser's token-gated local control channel (ws://127.0.0.1:7980, token in
 * ~/.8gent/browser-control.token), the same channel ~/.8gent/bin/8b-web uses. Concepts imported
 * from the 8gent-computer CUA (src/main/cu/), rebuilt here, not copied:
 *   - action spec: a closed action vocabulary with hard caps (actionSpec.ts validateAction)
 *   - dry run: the whole plan is validated and resolved against the current page before the
 *     first act; one bad step refuses the plan with nothing touched (dryRun.ts)
 *   - verify after act: re-read the page after every step; a type that did not land is retried
 *     once, then stops the plan (verify.ts). Clicks are never retried: a retried toggle undoes itself.
 *   - action log: one row per step, typed text logged as length only (actionLog.ts)
 * Only tabs this process opened are driven, never the user's own tabs.
 *
 * Named profile (#3622, paired with 8gent-browser #82): EIGHT_BROWSER_PROFILE=<name> points every call at
 * that profile's own isolated 8gent Browser instance (its token and port file under
 * ~/.8gent/browser-profiles/<name>/), never the person's logged-in default profile. A bad name is an
 * error: there is no fallback to the default token or port 7980.
 *
 * Local sessions (#3785): with EIGHT_BROWSER_PROFILE unset, a local-model session uses the isolated
 * profile "eight-local" (setDefaultLocalProfile, called by agent.ts), started on demand with a minimal
 * environment. EIGHT_BROWSER_LOCAL=0 opts out (no browser tools for local models, as before). Inside an
 * isolated profile, loopback is reachable only on the run's own listed ports (loopback-allowlist.ts).
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import {
	dirname,
	join,
	posix as pathPosix,
	win32 as pathWin32,
	resolve as resolvePath,
} from "node:path";
import {
	RESERVED_LOOPBACK_PORTS,
	allowedLoopbackPorts,
	ignoredWorkspaceAllowlist,
	isAllowedLoopbackUrl,
} from "../permissions/loopback-allowlist";
import { canApplySeatbelt } from "../permissions/run-command-sandbox";
import {
	BlockedDestinationError,
	type Resolver,
	checkDestination,
	classifyAddress,
} from "./net-guard";

export type BrowserCall = (cmd: string, args?: Record<string, unknown>) => Promise<any>;
export type BrowserAction =
	| { action: "open"; url: string }
	| { action: "left_click"; index?: number; selector?: string }
	| { action: "type"; selector?: string; index?: number; text: string }
	| { action: "wait_for"; selector: string; timeout_ms?: number }
	| { action: "scroll"; dy: number };

export const BROWSER_ACTION_KINDS = ["open", "left_click", "type", "wait_for", "scroll"] as const;
const LIMITS = { maxTypeLength: 4_000, maxWaitMs: 10_000, maxScroll: 10_000, maxSteps: 25 };
/** Clicks that need the person's approval, most sensitive first. purchase and authenticate mirror
 *  8gent-browser src/main/approval-gate.ts:20-33 (sensitiveCategory); destructive and commit are ours. */
const SENSITIVE: ReadonlyArray<readonly [string, readonly string[]]> = [
	[
		"purchase",
		[
			"card number",
			"credit card",
			"cvv",
			"cvc",
			"security code",
			"iban",
			"billing",
			"checkout",
			"place order",
			"buy now",
			"buy",
			"pay now",
			"pay",
			"payment",
			"purchase",
			"subscribe",
			"donate",
		],
	],
	["destructive", ["delete", "remove", "destroy", "transfer", "unsubscribe"]],
	[
		"authenticate",
		[
			"password",
			"passphrase",
			"otp",
			"one-time",
			"2fa",
			"mfa",
			"verification code",
			"log in",
			"login",
			"sign in",
			"signin",
			"sign-in",
			"credential",
		],
	],
	["commit", ["send", "submit", "confirm", "publish", "approve", "merge", "sign"]],
];
const wordRe = (t: string) =>
	new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`, "i");
export function sensitiveCategory(text: string): string | null {
	for (const [cat, terms] of SENSITIVE) if (terms.some((t) => wordRe(t).test(text))) return cat;
	return null;
}
/** Approver for sensitive clicks: resolves true to go ahead. Absent means refuse. */
export type ApproveFn = (what: string) => Promise<boolean>;

type Check<T> = { ok: true; action: T } | { ok: false; error: string };

// ── Named profile: loopback and private hosts (#3622, 8SO review) ────────────
// The same rule 8gent-browser enforces at its network layer (src/main/private-net.ts);
// checked here first so a refused URL never reaches the browser. WHATWG URL parsing
// normalises numeric hosts (2130706433, 0x7f000001, 0177.0.0.1 -> 127.0.0.1).

function v4Private(h: string): boolean {
	const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	return (
		a === 127 ||
		a === 10 ||
		a === 0 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

/** Why `url` is refused in a named profile, or null: non-http(s), credentials in the URL,
 *  or a loopback / private / link-local / CGNAT / .local / localhost host. */
export function blockedForProfile(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return "unparseable URL";
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return `scheme ${u.protocol} not allowed`;
	if (u.username || u.password) return "credentials in URL";
	let host = u.hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	if (host.endsWith(".")) host = host.slice(0, -1); // "localhost." and "127.0.0.1." are the same hosts
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
		return "private address";
	if (v4Private(host)) return "private address";
	if (host.includes(":")) {
		if (host === "::1" || host === "::") return "private address";
		if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host))
			return "private address";
		// IPv4 carried in IPv6: mapped (::ffff:), translated (::ffff:0:), compatible (::a.b.c.d,
		// which WHATWG prints as ::7f00:1) and NAT64 (64:ff9b::). Check the embedded address.
		const mapped = host.match(/^(?:::ffff:(?:0:)?|::|64:ff9b::)(.+)$/);
		if (mapped) {
			if (v4Private(mapped[1])) return "private address";
			const hex = mapped[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
			if (hex) {
				const n = (Number.parseInt(hex[1], 16) << 16) | Number.parseInt(hex[2], 16);
				if (v4Private([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")))
					return "private address";
			}
		}
	}
	return null;
}

// ── Destination guard, every profile (#3603) ─────────────────────────────────
// web_fetch refuses private, link-local and metadata destinations through net-guard.ts; the
// browser path had that rule only inside a named profile. Now every open (browser_open and an
// open step in browser_task) goes through the same classification, DNS answers included.
// Loopback is the one exception, and only for a host:port the person or task listed in
// EIGHT_BROWSER_ALLOW_LOOPBACK (comma separated, e.g. "127.0.0.1:5173,localhost:3000").
// The browser's own network layer (8gent-browser private-net.ts) stays as the second check.

let testResolver: Resolver | null = null;
/** Test seam: a fixed DNS answer so destination checks never touch the network. */
export function _setResolverForTest(r: Resolver | null): void {
	testResolver = r;
}

/** Loopback host:port entries from the environment. Non-loopback entries are dropped at use. */
export function loopbackAllowlist(env: Env = process.env): string[] {
	return (env.EIGHT_BROWSER_ALLOW_LOOPBACK ?? "")
		.split(",")
		.map((x) => x.trim().toLowerCase())
		.filter(Boolean);
}

function hostPort(u: URL): string {
	let host = u.hostname.toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	host = host.replace(/\.+$/, "");
	const port = u.port || (u.protocol === "https:" ? "443" : "80");
	return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function isLoopbackHost(host: string): boolean {
	const h = host.startsWith("[") ? host.slice(1, -1) : host;
	return h === "localhost" || h.endsWith(".localhost") || classifyAddress(h) === "loopback";
}

/** Why a browser destination is refused, or null. Network-free for literals; resolves names. */
export async function blockedBrowserDestination(
	url: string,
	opts: { allowLoopback?: string[]; resolve?: Resolver } = {},
): Promise<string | null> {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return `Refused: "${url}" is not a valid URL.`;
	}
	const hp = hostPort(u);
	const host = hp.slice(0, hp.lastIndexOf(":"));
	const allowed = (opts.allowLoopback ?? []).map((x) => x.trim().toLowerCase());
	if (
		(u.protocol === "http:" || u.protocol === "https:") &&
		isLoopbackHost(host) &&
		allowed.includes(hp)
	)
		return null;
	try {
		await checkDestination(url, { resolve: opts.resolve });
		return null;
	} catch (e) {
		if (e instanceof BlockedDestinationError) return e.message.replace(/ web_fetch only.*$/, "");
		throw e;
	}
}

// ── Secret placeholders (#3604) ──────────────────────────────────────────────
// The model writes {{secret:NAME}} in type.text. The driver swaps in the real value at act time,
// from a local file the person controls, so the value never sits in the model context, the
// transcript or the provider request. Each secret lists the hosts it may be typed on (a secret
// is never typed into a page the model steered somewhere else), and the file must be private
// to the user. Output, errors and the page read-back are scrubbed of every resolved value.

const PLACEHOLDER = /\{\{secret:([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;

// {{file:TASK.txt:Password}} (#4280, 8GO battle-harden move 7): a credential the task
// itself supplies, read from a "Password: ..." line of a workspace file at act time. Login state is
// fixture, not model labour: the model never copies the value through the shell or its context.
// Typed only on a loopback page whose origin is written in that same file.
const FILE_PLACEHOLDER = /\{\{file:([^{}:]{1,200}):([A-Za-z][A-Za-z0-9 _-]{0,63})\}\}/g;
const MAX_TASK_FILE_BYTES = 64 * 1024;
/** The one dot folder a task file may live in: the work dir's scratch space, where the login recipe writes. */
const SCRATCH_DIR = ".tmp";
const ANY_PLACEHOLDER = new RegExp(`${PLACEHOLDER.source}|${FILE_PLACEHOLDER.source}`, "g");

export const hasSecretPlaceholder = (text: string): boolean => {
	PLACEHOLDER.lastIndex = 0;
	FILE_PLACEHOLDER.lastIndex = 0;
	return PLACEHOLDER.test(text) || FILE_PLACEHOLDER.test(text);
};

/** Read `path` through an O_NOFOLLOW fd: a regular file, small, one link. Throws otherwise. */
function readSmallRegularFile(path: string): string {
	const fd = openSync(
		path,
		fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
	);
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.size > MAX_TASK_FILE_BYTES || st.nlink !== 1)
			throw new Error("not a small regular file with a single link");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/**
 * The value of the `field:` line in workspace file `rel`, if it may be typed on `pageUrl`. Refused:
 * an absolute path, any dot segment (.env, .git, ..), a path that resolves outside the workspace,
 * anything but a small regular file, a missing field, and a page that is not loopback or whose
 * origin is not written in the file. Errors name the file and field, never the value.
 */
export function resolveTaskFileField(
	workspace: string | undefined,
	rel: string,
	field: string,
	pageUrl: string,
): { ok: true; value: string } | { ok: false; error: string } {
	// Not "path:field: why": the secret scanner reads "password: <text>" as a secret assignment and
	// blanked the whole error (#4417), so the model never learned why the fill failed.
	const label = `${rel} (field ${field})`;
	if (!workspace) return { ok: false, error: `${label}: no workspace for file placeholders` };
	const segs = rel.split(/[\\/]/);
	if (
		pathPosix.isAbsolute(rel) ||
		pathWin32.isAbsolute(rel) ||
		segs.some((x, i) => x === "" || (x.startsWith(".") && !(i === 0 && x === SCRATCH_DIR)))
	)
		return {
			ok: false,
			error: `Expected a workspace path, or .tmp/<name>, not ${rel}; no absolute path, dot segment or empty segment.`,
		};
	let text: string;
	try {
		const root = realpathSync.native(workspace);
		/** Inside the workspace, and no segment of the resolved path (a symlink target too) is a dot name. */
		const contained = (real: string) => {
			if (!secretsPathInHome(real, root, process.platform)) return false;
			const p = process.platform === "win32" ? pathWin32 : pathPosix;
			return !p
				.relative(root, real)
				.split(/[\\/]/)
				.some((x, i) => x.startsWith(".") && !(i === 0 && x === SCRATCH_DIR));
		};
		const real = realpathSync.native(join(root, rel));
		if (!contained(real))
			return {
				ok: false,
				error: `Expected a workspace path, or .tmp/<name>, not ${rel}; it resolves outside the workspace or to a dot file.`,
			};
		const checked = lstatSync(real);
		// Refuse before opening: opening a FIFO or device can block, and a big file is never a task file.
		if (!checked.isFile() || checked.size > MAX_TASK_FILE_BYTES)
			return { ok: false, error: `${label}: not a small regular file with a single link` };
		// Read through one handle: no follow on the last component, and the handle must be the very
		// file checked (same device and inode), a regular file, small, with exactly one link (a hard
		// link can alias a file outside the workspace).
		const fd = openSync(
			real,
			fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
		);
		try {
			const st = fstatSync(fd);
			if (
				!st.isFile() ||
				st.size > MAX_TASK_FILE_BYTES ||
				st.nlink !== 1 ||
				st.dev !== checked.dev ||
				st.ino !== checked.ino
			)
				return { ok: false, error: `${label}: not a small regular file with a single link` };
			// The path must still resolve to the same place: a parent swapped since the check is refused.
			const again = realpathSync.native(real);
			if (again !== real || !contained(again))
				return { ok: false, error: `${label}: the file moved while it was being read` };
			text = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return { ok: false, error: `${label}: the file could not be read` };
	}
	const esc = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	// "Field: value" or "Field=value" (the .tmp/login recipe writes password=...).
	const m = new RegExp(`^[ \\t]*${esc}[ \\t]*[:=][ \\t]*(\\S(?:.*\\S)?)[ \\t\\r]*$`, "im").exec(
		text,
	);
	if (!m)
		return {
			ok: false,
			error: `Expected a line \`Field: value\` or \`Field=value\` in ${rel} for field ${field}; none found.`,
		};
	// A tab or other control character would move focus and type the rest into another field.
	if (/[\x00-\x1f\x7f]/.test(m[1]))
		return { ok: false, error: `${label}: the value holds a control character` };
	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		return { ok: false, error: `${label}: the page has no address` };
	}
	const origins = new Set<string>();
	// A scratch copy of the login (.tmp/login) holds credentials only; the address stays in the task file.
	let addressText = text;
	if (segs[0] === SCRATCH_DIR) {
		try {
			addressText += `\n${readSmallRegularFile(join(realpathSync.native(workspace), "TASK.txt"))}`;
		} catch {
			// A missing or unreadable TASK.txt only narrows the origin set, so the empty catch is intentional.
		}
	}
	for (const u of addressText.match(/https?:\/\/[^\s<>"'`)]+/g) ?? []) {
		try {
			origins.add(new URL(u).origin);
		} catch {}
	}
	if (!isLoopbackHost(page.hostname) || !origins.has(page.origin))
		return {
			ok: false,
			error: `${label}: typed only on a local (loopback) address written in that file, not on ${page.origin}`,
		};
	return { ok: true, value: m[1] };
}

/**
 * True when `file` is `home` or below it, compared with the rules of `platform`
 * (case-insensitive on win32). Pure, so the Windows rule is testable on any OS.
 */
export function secretsPathInHome(file: string, home: string, platform: NodeJS.Platform): boolean {
	const p = platform === "win32" ? pathWin32 : pathPosix;
	const norm = (x: string) => (platform === "win32" ? p.resolve(x).toLowerCase() : p.resolve(x));
	const rel = p.relative(norm(home), norm(file));
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

/** Secrets file: { "NAME": { "value": "...", "hosts": ["app.example.com"] } }, mode 0600. */
export function resolveSecretText(
	text: string,
	pageUrl: string,
	file: string | undefined = process.env.EIGHT_BROWSER_SECRETS_FILE,
	/** Workspace root for {{file:PATH:FIELD}} placeholders; none refuses them. */
	workspace?: string,
): { ok: true; text: string; values: Map<string, string> } | { ok: false; error: string } {
	PLACEHOLDER.lastIndex = 0;
	let table: Record<string, { value?: unknown; hosts?: unknown }> | null = null;
	if (PLACEHOLDER.test(text)) {
		if (!file) return { ok: false, error: "no secrets file is configured for placeholders" };
		try {
			// Windows has no POSIX mode bits (stat reports 0o666 for every file), so the mode check
			// would refuse every secrets file there. Instead the file must live under the user's home,
			// whose NTFS ACL is user-only by default. The ACL itself is not read: accepted risk,
			// docs/security/windows-secrets-file.md.
			if (
				process.platform === "win32" &&
				!secretsPathInHome(realpathSync.native(file), realpathSync.native(homedir()), "win32")
			)
				return { ok: false, error: "on Windows the secrets file must be inside your home folder" };
			if (process.platform !== "win32" && statSync(file).mode & 0o077)
				return { ok: false, error: "the secrets file must not be readable by group or others" };
			table = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return { ok: false, error: "the secrets file could not be read" };
		}
	}
	let host = "";
	try {
		host = new URL(pageUrl).hostname.toLowerCase();
	} catch {}
	const values = new Map<string, string>();
	let failure: string | null = null;
	// One pass over both forms, so a resolved value is never itself read as a placeholder.
	const out = text.replace(
		ANY_PLACEHOLDER,
		(whole, name?: string, rel?: string, field?: string) => {
			if (rel !== undefined && field !== undefined) {
				const r = resolveTaskFileField(workspace, rel, field, pageUrl);
				if (!r.ok) {
					failure ??= r.error;
					return "";
				}
				values.set(whole, r.value);
				return r.value;
			}
			const key = name ?? "";
			const e = table && Object.hasOwn(table, key) ? table[key] : undefined;
			if (!e || typeof e.value !== "string" || e.value === "") {
				failure ??= `secret ${key} is not available`;
				return "";
			}
			if (!Array.isArray(e.hosts) || !e.hosts.some((h) => String(h).toLowerCase() === host)) {
				failure ??= `secret ${key} is not allowed on this page`;
				return "";
			}
			values.set(whole, e.value);
			return e.value;
		},
	);
	if (failure) return { ok: false, error: failure };
	if (out.length > LIMITS.maxTypeLength)
		return { ok: false, error: `type.text > ${LIMITS.maxTypeLength} chars after resolving` };
	return { ok: true, text: out, values };
}

export function validateBrowserAction(
	raw: unknown,
	opts: {
		isolated?: boolean;
		/** Isolated only: true for a loopback URL on one of the run's own listed ports (#3785). */
		allowedLoopback?: (url: string) => boolean;
		/** Isolated only: a line added to a refusal, e.g. that a workspace allowlist was ignored. */
		refusalNote?: () => string | null;
	} = {},
): Check<BrowserAction> {
	if (!raw || typeof raw !== "object") return { ok: false, error: "action must be an object" };
	const a = raw as Record<string, unknown>;
	const sel = typeof a.selector === "string" && a.selector.trim() ? a.selector : undefined;
	switch (a.action) {
		case "open": {
			if (typeof a.url !== "string" || !/^https?:\/\//.test(a.url))
				return { ok: false, error: "open.url must be http(s)" };
			const why = opts.isolated && !opts.allowedLoopback?.(a.url) ? blockedForProfile(a.url) : null;
			if (why) {
				const note = opts.refusalNote?.();
				return {
					ok: false,
					error: `open.url refused in this browser profile: ${why}${note ? ` ${note}` : ""}`,
				};
			}
			return { ok: true, action: { action: "open", url: a.url } };
		}
		case "left_click": {
			const index =
				Number.isInteger(a.index) && (a.index as number) >= 0 ? (a.index as number) : undefined;
			if (index === undefined && !sel)
				return { ok: false, error: "left_click needs index or selector" };
			return { ok: true, action: { action: "left_click", index, selector: sel } };
		}
		case "type": {
			const index =
				Number.isInteger(a.index) && (a.index as number) >= 0 ? (a.index as number) : undefined;
			if ((!sel && index === undefined) || typeof a.text !== "string")
				return { ok: false, error: "type needs index or selector, and text" };
			if (a.text.length > LIMITS.maxTypeLength)
				return { ok: false, error: `type.text > ${LIMITS.maxTypeLength} chars` };
			return sel
				? { ok: true, action: { action: "type", selector: sel, text: a.text } }
				: { ok: true, action: { action: "type", index, text: a.text } };
		}
		case "wait_for": {
			if (!sel) return { ok: false, error: "wait_for needs selector" };
			const t =
				typeof a.timeout_ms === "number"
					? Math.min(Math.max(a.timeout_ms, 0), LIMITS.maxWaitMs)
					: 5_000;
			return { ok: true, action: { action: "wait_for", selector: sel, timeout_ms: t } };
		}
		case "scroll": {
			if (typeof a.dy !== "number" || !Number.isFinite(a.dy))
				return { ok: false, error: "scroll.dy must be a number" };
			return {
				ok: true,
				action: {
					action: "scroll",
					dy: Math.max(-LIMITS.maxScroll, Math.min(a.dy, LIMITS.maxScroll)),
				},
			};
		}
	}
	return { ok: false, error: `unknown action kind: ${String(a.action)}` };
}

type Env = Record<string, string | undefined>;
export type BrowserProfile = { name: string; tokenFile: string; portFile: string };
const DEFAULT_CONTROL_PORT = 7980;
const PROFILE_NAME = /^[a-z][a-z0-9-]{1,31}$/; // same rule as 8gent-browser src/main/profile.ts
let profileHomeOverride: string | null = null;
/** Test seam: resolve profiles under this HOME instead of the real one. Never set outside tests. */
export function _setProfileHomeForTest(home: string | null): void {
	profileHomeOverride = home;
}

// ── Default local profile (#3785) ────────────────────────────────────────────
// A local-model session with no EIGHT_BROWSER_PROFILE used to get no browser at all, so local models
// fell back to curl for ordinary browser tasks. Now agent.ts declares a default isolated profile for
// local providers (never by writing process.env), and every rule of a named profile holds for it.

/** The isolated profile a local session uses when EIGHT_BROWSER_PROFILE is unset. */
export const LOCAL_BROWSER_PROFILE = "eight-local";
let defaultLocalProfile: string | null = null;

/** Declare (or clear, with null) the profile used when EIGHT_BROWSER_PROFILE is unset. The name must
 *  be a valid slug, so the default can never be the default profile or resolve to the default token. */
export function setDefaultLocalProfile(name: string | null): void {
	if (name !== null && (!PROFILE_NAME.test(name) || name === "default"))
		throw new Error(
			`default local browser profile must be a slug; refusing ${JSON.stringify(name)}`,
		);
	defaultLocalProfile = name;
	// Freeze the trusted loopback port list now, at session start (8SO): a file a tool writes before
	// the first browser call must change nothing.
	allowedLoopbackPorts(process.env, profileHomeOverride ?? homedir());
}

/** The declared default, or null when none applies: EIGHT_BROWSER_LOCAL=0 opts out and the opt-in
 *  browser-use backend never gets an isolated profile. */
function localDefault(env: Env): string | null {
	if (defaultLocalProfile === null) return null;
	if (env.EIGHT_BROWSER_LOCAL === "0" || env.EIGHT_BROWSER_BACKEND === "browser-use") return null;
	return defaultLocalProfile;
}

/** True when the profile in use is the declared default, not an explicit EIGHT_BROWSER_PROFILE. */
export function usingDefaultLocalProfile(env: Env = process.env): boolean {
	const name = env.EIGHT_BROWSER_PROFILE;
	return (name === undefined || name === "") && localDefault(env) !== null;
}

/**
 * The named 8gent Browser profile this process uses, or null for the default profile ("default", or
 * unset/empty with no local default declared). A name that is not a short lowercase slug throws: it never
 * falls back to the default profile, and since it cannot contain "/" or "." it can never resolve to the
 * default token.
 */
export function browserProfile(
	env: Env = process.env,
	home: string = profileHomeOverride ?? homedir(),
): BrowserProfile | null {
	let name = env.EIGHT_BROWSER_PROFILE;
	if (name === undefined || name === "") name = localDefault(env) ?? undefined;
	if (name === undefined || name === "default") return null;
	if (!PROFILE_NAME.test(name))
		throw new Error(
			`EIGHT_BROWSER_PROFILE must be a lowercase slug (a-z, 0-9, -; 2-32 chars, starting with a letter); refusing ${JSON.stringify(name)}`,
		);
	const dir = join(home, ".8gent", "browser-profiles", name);
	return {
		name,
		tokenFile: join(dir, "browser-control.token"),
		portFile: join(dir, "browser-control.port"),
	};
}

/** True only when a valid named profile is configured AND 8gent Browser is the backend: the
 *  bot's own login-free browser. The opt-in browser-use backend never gets the exemptions. */
export function isolatedBrowser(env: Env = process.env): boolean {
	if (env.EIGHT_BROWSER_BACKEND === "browser-use") return false;
	try {
		return browserProfile(env) !== null;
	} catch {
		return false;
	}
}

/** One warning line for a bad EIGHT_BROWSER_PROFILE, or null. Printed once when a local session starts. */
export function browserProfileWarning(env: Env = process.env): string | null {
	try {
		browserProfile(env);
		return null;
	} catch (e) {
		return `${(e as Error).message}; this session has no browser tools`;
	}
}

/**
 * How to drive a local web app with curl so System One's loopback lane (permissions/s1-curl-loopback.ts)
 * passes it without asking the judge. One source for the full prompt (TOOL_PATTERNS_SEGMENT) and the
 * withheld-browser note, which is the only one of the two a local text-tool session receives: the compact
 * local prompt has no TOOL_PATTERNS_SEGMENT, so before this the local model never saw these rules.
 */
export const LOCAL_SERVER_CURL_NOTE =
	"For a local server (127.0.0.1 or localhost), use run_command with one plain curl per call: no pipes, ; or &&. " +
	"Keep cookie, header and output files under .tmp/ in the project, never /tmp " +
	"(curl -s -c .tmp/cj.txt -b .tmp/cj.txt -o .tmp/page.html URL), then read_file them. " +
	"Do not pass -L: on a 302, read the Location header and make a second loopback request.";

/** Browser tools a local-model session may see: the four 8gent Browser tools whenever an isolated
 *  profile applies (an explicit EIGHT_BROWSER_PROFILE, or the local default), none otherwise. */
export function localBrowserTools(env: Env = process.env): string[] {
	return isolatedBrowser(env)
		? ["browser_open", "browser_state", "browser_task", "browser_screenshot"]
		: [];
}

/**
 * Why the browser tools are not in a local session, or null when they are offered (#3785). Shown in the
 * local tool catalog and in the result of a browser_* call that is not registered, so a model that was
 * told to use "the browser" learns the reason and the way to get it instead of rediscovering each gate.
 */
export function browserWithheldNote(env: Env = process.env): string | null {
	if (localBrowserTools(env).length > 0) return null;
	const tools =
		"Browser tools (browser_open, browser_state, browser_task, browser_screenshot) are not offered in this session: ";
	if (env.EIGHT_BROWSER_LOCAL === "0" && (env.EIGHT_BROWSER_PROFILE ?? "") === "")
		return `${tools}EIGHT_BROWSER_LOCAL=0 turned off the session's own isolated browser profile. Unset it to get them back. For a local web app, follow the local-server curl rules in your instructions.`;
	return `${tools}no isolated browser profile is configured. To get them, leave EIGHT_BROWSER_PROFILE unset (the session starts its own isolated profile) or set it to a running 8gent Browser profile. Even then they open loopback only on ports listed in EIGHT_BROWSER_ALLOW_LOOPBACK and never open other private addresses. For a local web app, follow the local-server curl rules in your instructions.`;
}

// ── Start on demand (#3785) ──────────────────────────────────────────────────
// A named profile whose port file is absent is launched once per process, as its own detached
// 8gent Browser instance, with an environment built from scratch: no API keys, no tokens, nothing
// inherited from this process. The port is fresh (never 7980, never a reserved service port) and the
// browser learns the run's own loopback ports through EIGHT_BROWSER_ALLOW_LOOPBACK. One attempt per
// profile per process: a failed launch stays failed, with the same short reason, until the next process.

/** Everything a launch needs; handed to the spawner so tests can fake the whole thing. */
export type BrowserLaunchSpec = {
	bin: string;
	profile: string;
	port: number;
	env: Record<string, string>;
	portFile: string;
	tokenFile: string;
	/** Where the child's stderr goes (next to the port file), so a crash leaves its own last line behind. */
	logFile: string;
};
/** `exited` resolves when the child has exited (or could not be started), with a short reason. `pid`
 *  is the child to stop if it never publishes a port; `detached` means it leads its own process group,
 *  so the whole group (Electron's helpers too) is signalled. */
export type BrowserSpawnFn = (spec: BrowserLaunchSpec) => {
	exited: Promise<string>;
	pid?: number;
	detached?: boolean;
};

let spawnOverride: BrowserSpawnFn | null = null;
/** Test seam: fake the process launch. Never set outside tests. */
export function _setSpawnForTest(fn: BrowserSpawnFn | null): void {
	spawnOverride = fn;
	launches.clear();
}

// ── Host sandbox pre-flight (#4099) ──────────────────────────────────────────
// Chromium's browser process registers a Mach rendezvous port with launchd (bootstrap_check_in) the
// first time it launches a child. A seatbelt sandbox around this process denies that, so under a host
// sandbox 8gent Browser traps about 150 ms after spawn (SIGTRAP, "mach_port_rendezvous_mac.cc: Check
// failed: kr == KERN_SUCCESS ... Permission denied (1100)", one macOS crash report per attempt) before it
// can publish a port. Checked before anything is spawned, with the probe run_command already uses to
// learn that sandbox-exec cannot nest; a positive answer is the same error every time, with no crash.
let hostSandboxOverride: boolean | null = null;
/** Test seam: pretend the host sandbox is present (true) or absent (false). Never set outside tests. */
export function _setHostSandboxedForTest(v: boolean | null): void {
	hostSandboxOverride = v;
	launches.clear();
}
/** True when this process sits inside a macOS sandbox that 8gent Browser cannot start under. */
export function hostSandboxBlocksBrowser(): boolean {
	if (hostSandboxOverride !== null) return hostSandboxOverride;
	return (
		process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && !canApplySeatbelt()
	);
}
export const HOST_SANDBOX_REASON =
	"this process runs inside a macOS sandbox, where 8gent Browser cannot register its Mach port with launchd; start the profile from outside the sandbox (same HOME and EIGHT_BROWSER_PROFILE) and the session connects to it";

/** The line worth keeping from a dead child's stderr: the last FATAL or "Check failed" line, else the
 *  last non-empty one, without Chromium's "[pid:mmdd/hhmmss.us:" prefix and cut to 240 chars. */
export function launchLogTail(file: string): string | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return null;
	}
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length === 0) return null;
	const fatal = [...lines].reverse().find((l) => /FATAL|Check failed/.test(l));
	const pick = fatal ?? lines[lines.length - 1];
	return pick.replace(/^\[\d+:\d+\/[\d.]+:/, "").slice(0, 240);
}

const realSpawn: BrowserSpawnFn = (spec) => {
	let log: number | null = null;
	try {
		// The dir and the log exist before the browser does, so they get the modes the browser would
		// give them (8gent-browser control-server.ts makes the profile dir 0o700): nothing looser.
		mkdirSync(dirname(spec.logFile), { recursive: true, mode: 0o700 });
		log = openSync(spec.logFile, "w", 0o600);
	} catch {
		log = null;
	}
	let pid: number | undefined;
	const exited = new Promise<string>((done) => {
		try {
			const child = spawn(spec.bin, [], {
				env: spec.env as NodeJS.ProcessEnv,
				detached: true,
				stdio: ["ignore", "ignore", log ?? "ignore"],
				windowsHide: true,
			});
			pid = child.pid;
			child.once("error", (e: Error) => done(`spawn failed: ${e.message}`));
			child.once("exit", (code: number | null, signal: string | null) => {
				const tail = launchLogTail(spec.logFile);
				done(`exited with ${signal ?? `code ${code}`}${tail ? `: ${tail}` : ""}`);
			});
			child.unref();
		} catch (e) {
			done(`spawn failed: ${(e as Error).message}`);
		} finally {
			if (log !== null) closeSync(log);
		}
	});
	return { exited, pid, detached: true };
};

let appDirsOverride: string[] | null = null;
/** Test seam: look for app bundles in these directories instead of the real ones. Never set outside tests. */
export function _setAppDirsForTest(dirs: string[] | null): void {
	appDirsOverride = dirs;
}

/**
 * The 8gent Browser binary: EIGHT_BROWSER_APP, else the macOS app bundle in /Applications,
 * ~/Applications or ~/.8gent/apps (#3589). The first build there that can run a named profile wins, so
 * an old desktop-v0.3.0 in /Applications no longer hides a newer build in ~/.8gent/apps. With no capable
 * build the first one found is returned, and launchOnce refuses it with the same "update it" error.
 */
export function browserBinary(env: Env = process.env, home: string = homedir()): string | null {
	if (env.EIGHT_BROWSER_APP) return env.EIGHT_BROWSER_APP;
	if (process.platform !== "darwin") return null;
	const rel = join("8gent Browser.app", "Contents", "MacOS", "8gent Browser");
	const dirs = appDirsOverride ?? [
		"/Applications",
		join(home, "Applications"),
		join(home, ".8gent", "apps"),
	];
	const found = dirs.map((d) => join(d, rel)).filter((p) => existsSync(p));
	return found.find((p) => profileSupportProblem(p) === null) ?? found[0] ?? null;
}

/** A free TCP port on loopback that is not the default control port or a reserved service port. */
function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => {
				if (port === DEFAULT_CONTROL_PORT || RESERVED_LOOPBACK_PORTS.has(port) || port <= 0)
					return resolve(freePort());
				resolve(port);
			});
		});
	});
}

// ── Named-profile support (#4103) ───────────────────────────────────────────
// Named profiles landed in 8gent-browser 18ce4ad, after desktop-v0.3.0. An older build ignores
// EIGHT_BROWSER_PROFILE, writes the default token and runs on Electron's default userData: the
// person's own logged-in profile. So a build that cannot honour the profile is never started.
/** First release with named profiles. Builds of main after 18ce4ad still say 0.3.0, so for 0.3.0
 *  and below the app's own bundle decides: it must carry PROFILE_MARKER. */
export const PROFILE_MIN_VERSION = "0.3.1";
/** The env var src/main/profile.ts reads; it survives bundling and minifying, and no pre-profile
 *  build contains it (desktop-v0.3.0 app.asar: zero occurrences). */
const PROFILE_MARKER = "EIGHT_BROWSER_PROFILE";

/** Negative, zero or positive as dotted version a is below, equal to or above b. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
	const pb = b.split(/[.+-]/).map((x) => Number.parseInt(x, 10) || 0);
	for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
	return 0;
}

/** The bundle files next to a binary: Info.plist (macOS .app) and app.asar, where they exist. */
function appBundleFiles(bin: string): { plist: string | null; asar: string | null } {
	const dir = dirname(bin);
	const contents = dirname(dir);
	const mac = /[\\/]Contents[\\/]MacOS$/.test(dir);
	const plist = mac ? join(contents, "Info.plist") : null;
	const asars = mac
		? [join(contents, "Resources", "app.asar")]
		: [join(dir, "resources", "app.asar")];
	return {
		plist: plist && existsSync(plist) ? plist : null,
		asar: asars.find((a) => existsSync(a)) ?? null,
	};
}

/** CFBundleShortVersionString from an XML Info.plist, or null. */
function plistVersion(plist: string): string | null {
	try {
		const m = readFileSync(plist, "utf8").match(
			/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/,
		);
		return m ? m[1].trim() : null;
	} catch {
		return null;
	}
}

/**
 * Why this 8gent Browser build cannot run a named profile, or null when it can. Cheap first: a version
 * at or above PROFILE_MIN_VERSION passes on the plist alone. Otherwise the app.asar must carry the
 * marker. With neither file (a dev binary or script in EIGHT_BROWSER_APP) nothing can be told before
 * launch, so this returns null and launchOnce's default-token check is the guard.
 */
export function profileSupportProblem(bin: string): string | null {
	const { plist, asar } = appBundleFiles(bin);
	const version = plist ? plistVersion(plist) : null;
	if (version && compareVersions(version, PROFILE_MIN_VERSION) >= 0) return null;
	let marked: boolean | null = null;
	if (asar) {
		try {
			marked = readFileSync(asar).includes(PROFILE_MARKER);
		} catch {
			marked = null;
		}
	}
	if (marked === true) return null;
	if (marked === null && !version) return null;
	return `the installed 8gent Browser ${version ?? "(version unknown)"} does not support named profiles; it needs ${PROFILE_MIN_VERSION} or later. Update it or set EIGHT_BROWSER_APP to a newer build`;
}

const PRE_PROFILE_SEEN =
	"the 8gent Browser it started does not support named profiles: it wrote the default profile's token, not the profile's own";

let launchWaitMs = 20_000;
/** Test seam: shorten the wait for a port file. null restores 20 s. Never set outside tests. */
export function _setLaunchWaitForTest(ms: number | null): void {
	launchWaitMs = ms ?? 20_000;
	launches.clear();
}
const STOP_GRACE_MS = 1_500;
const launches = new Map<string, Promise<void>>();

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

let killFn: (pid: number, sig: NodeJS.Signals) => void = (pid, sig) => {
	process.kill(pid, sig);
};
/** Test seam: replace process.kill for stopChild. null restores it. Never set outside tests. */
export function _setKillForTest(fn: ((pid: number, sig: NodeJS.Signals) => void) | null): void {
	killFn =
		fn ??
		((pid, sig) => {
			process.kill(pid, sig);
		});
}

/** Stop a launched child that did not publish a port: SIGTERM to its process group (it was started
 *  detached), then SIGKILL after STOP_GRACE_MS. Returns the clause the error carries. */
async function stopChild(
	handle: { pid?: number; detached?: boolean },
	exited: Promise<unknown>,
): Promise<string> {
	const pid = handle.pid;
	if (!pid) return "";
	const group = handle.detached === true && process.platform !== "win32";
	// ESRCH on the group means the leader exited and was reaped: a bare-pid signal then could only
	// reach a reused pid, so the pid itself is tried only on EPERM (8SO review of #4104).
	const send = (sig: NodeJS.Signals) => {
		try {
			killFn(group ? -pid : pid, sig);
		} catch (e) {
			if (!group || (e as NodeJS.ErrnoException).code !== "EPERM") return;
			try {
				killFn(pid, sig);
			} catch {
				// already gone
			}
		}
	};
	send("SIGTERM");
	const gone = await Promise.race([
		exited.then(() => true),
		sleep(STOP_GRACE_MS).then(() => false),
	]);
	// Electron helpers can outlive the main process; the group gets SIGKILL either way.
	if (group || !gone) send("SIGKILL");
	if (!gone) await Promise.race([exited, sleep(1_000)]);
	return gone
		? "; stopped the browser it started"
		: "; killed the browser it started (SIGTERM was ignored)";
}

/** mtime of a file in ms, or null when absent. */
function mtimeOf(file: string): number | null {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return null;
	}
}

/** The actionable error for a launch that did not produce a running profile. The curl alternative is
 *  for a browser that is missing or broken; under a host sandbox it is left out (#4099), since it only
 *  steers the model into a curl sign-in the judge then blocks. */
const launchError = (reason: string, curlHint = true) =>
	new Error(
		`8gent Browser could not start (${reason}).${curlHint ? " For a local web app use run_command with curl instead." : ""}`,
	);

async function launchOnce(profile: BrowserProfile, home: string, env: Env): Promise<void> {
	const bin = browserBinary(env, home);
	if (!bin) throw launchError("no 8gent Browser app found; set EIGHT_BROWSER_APP to its binary");
	if (hostSandboxBlocksBrowser()) throw launchError(HOST_SANDBOX_REASON, false);
	// A build without named profiles would run on the person's own profile: never spawned (#4103).
	const unsupported = profileSupportProblem(bin);
	if (unsupported) throw launchError(unsupported, false);
	const port = await freePort();
	const ports = [...allowedLoopbackPorts(env, home)];
	// Built fresh: only what the browser needs to run and find its profile. Never the parent env.
	const childEnv: Record<string, string> = {
		HOME: home,
		PATH: env.PATH ?? "/usr/bin:/bin",
		EIGHT_BROWSER_PROFILE: profile.name,
		EIGHT_BROWSER_CONTROL_PORT: String(port),
		EIGHT_BROWSER_ALLOW_LOOPBACK: ports.map((p) => `127.0.0.1:${p}`).join(","),
	};
	for (const k of ["TMPDIR", "USER"] as const) if (env[k]) childEnv[k] = env[k] as string;
	const spec: BrowserLaunchSpec = {
		bin,
		profile: profile.name,
		port,
		env: childEnv,
		portFile: profile.portFile,
		tokenFile: profile.tokenFile,
		logFile: join(dirname(profile.portFile), "browser-launch.log"),
	};
	// A browser that ignores EIGHT_BROWSER_PROFILE writes the DEFAULT token under the same HOME.
	const defaultToken = join(home, ".8gent", "browser-control.token");
	const defaultTokenBefore = mtimeOf(defaultToken);
	const handle = (spawnOverride ?? realSpawn)(spec);
	const exit = handle.exited.then((reason) => ({ reason }));
	const ready = () => existsSync(profile.portFile) && existsSync(profile.tokenFile);
	const deadline = Date.now() + launchWaitMs;
	while (Date.now() < deadline) {
		if (ready()) return;
		if (!existsSync(profile.portFile) && mtimeOf(defaultToken) !== defaultTokenBefore) {
			const stopped = await stopChild(handle, handle.exited);
			throw launchError(
				`${PRE_PROFILE_SEEN}${stopped}. Update it or set EIGHT_BROWSER_APP to a newer build`,
				false,
			);
		}
		const r = await Promise.race([exit, sleep(100).then(() => null)]);
		if (r) {
			if (ready()) return;
			throw launchError(r.reason);
		}
	}
	const stopped = await stopChild(handle, handle.exited);
	throw launchError(
		`profile "${profile.name}" published no port within ${launchWaitMs / 1000} s${stopped}`,
	);
}

/** Start the profile's browser if its port file is absent. One attempt per profile per process. */
async function ensureRunning(profile: BrowserProfile, home: string, env: Env): Promise<void> {
	if (existsSync(profile.portFile)) return;
	let p = launches.get(profile.name);
	if (!p) {
		p = launchOnce(profile, home, env);
		launches.set(profile.name, p);
	}
	await p;
}

export type TransportOpts = {
	port?: number;
	tokenFile?: string;
	env?: Env;
};

/** Where to connect: a named profile's own token and published port (starting the profile when it
 *  is not running), else the default token and port. */
async function endpoint(opts: TransportOpts): Promise<{
	port: number;
	tokenFile: string;
	profile?: string;
}> {
	const env = opts.env ?? process.env;
	const home = profileHomeOverride ?? homedir();
	const profile = browserProfile(env, home);
	if (profile) {
		// Defence in depth (8SO HIGH-2): a process configured for a named profile never reaches the
		// default browser, whatever port or token file a caller passes.
		if (opts.port === DEFAULT_CONTROL_PORT)
			throw new Error(
				`EIGHT_BROWSER_PROFILE is set: refusing port ${DEFAULT_CONTROL_PORT}, the default profile's port`,
			);
		if (opts.tokenFile && opts.tokenFile !== profile.tokenFile)
			throw new Error(
				"EIGHT_BROWSER_PROFILE is set: refusing a control token that is not the profile's (default token)",
			);
	}
	if (!profile)
		return {
			port: opts.port ?? (Number(env.EIGHT_BROWSER_CONTROL_PORT) || DEFAULT_CONTROL_PORT),
			tokenFile: opts.tokenFile ?? join(homedir(), ".8gent", "browser-control.token"),
		};
	await ensureRunning(profile, home, env);
	let raw: string;
	try {
		raw = readFileSync(profile.portFile, "utf8").trim();
		readFileSync(profile.tokenFile, "utf8");
	} catch {
		throw new Error(
			`8gent Browser profile "${profile.name}" is not running (no token or port file in ~/.8gent/browser-profiles/${profile.name}/)`,
		);
	}
	const port = /^\d+$/.test(raw) ? Number(raw) : 0;
	if (port <= 0 || port >= 65536 || port === DEFAULT_CONTROL_PORT)
		throw new Error(
			`8gent Browser profile "${profile.name}" published an invalid port (${JSON.stringify(raw)}); refusing`,
		);
	return { port, tokenFile: profile.tokenFile, profile: profile.name };
}

/** WebSocket transport: one authenticated round trip per command, as 8b-web does. */
export function wsTransport(opts: TransportOpts = {}): BrowserCall {
	return async (cmd, args = {}) => {
		const { port, tokenFile } = await endpoint(opts);
		return new Promise((resolve, reject) => {
			let token: string;
			try {
				token = readFileSync(tokenFile, "utf8").trim();
			} catch {
				return reject(
					new Error(
						"8gent Browser control token not found; is 8gent Browser installed and running?",
					),
				);
			}
			const ws = new WebSocket(`ws://127.0.0.1:${port}`);
			let settled = false;
			const done = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				ws.close();
				fn();
			};
			const timer = setTimeout(
				() => done(() => reject(new Error(`8gent Browser timed out on ${cmd}`))),
				30_000,
			);
			ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token }));
			ws.onerror = () =>
				done(() => reject(new Error(`8gent Browser not reachable on 127.0.0.1:${port}`)));
			ws.onclose = () =>
				done(() =>
					reject(new Error(`8gent Browser closed the connection before answering ${cmd}`)),
				);
			ws.onmessage = (ev) => {
				let m: { type?: string; id?: number; ok?: boolean; result?: unknown; error?: string };
				try {
					m = JSON.parse(String(ev.data));
				} catch {
					return done(() => reject(new Error(`8gent Browser sent a bad message on ${cmd}`)));
				}
				if (m.type === "auth_ok") return ws.send(JSON.stringify({ id: 1, cmd, args }));
				if (m.type === "error") return done(() => reject(new Error(m.error)));
				if (m.id === 1) done(() => (m.ok ? resolve(m.result) : reject(new Error(m.error))));
			};
		});
	};
}
export const wsCall: BrowserCall = wsTransport();

type Rect = { x: number; y: number; w: number; h: number };
type El = {
	index: number;
	tag: string;
	role?: string;
	/** Accessible name from the browser (label[for], wrapping label, aria, placeholder, title), never a typed value. */
	name?: string;
	text: string;
	rect?: Rect;
	checked?: boolean;
	hidden?: boolean;
	secret?: boolean;
};
/** page.query's text form: whitespace collapsed, 120 chars (8gent-browser automation.ts queryElements). */
const clipped = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 120);

// ── run_command backstop (#3622, 8SO HIGH-2) ──────────────────────────────────
// A SPEED BUMP, not a boundary. run_command is neither path-guarded nor seatbelted, so a
// shell or `bun -e` could read ~/.8gent/browser-control.token and drive the person's
// logged-in browser. The real fix is seatbelting run_command (#3612); until that merges the
// bot's launcher does not set EIGHT_BROWSER_PROFILE. After decoding escapes, base64/hex
// literals and char codes, and stripping quoting, this refuses:
//   - the browser state names (browser-control, browser-profiles, browser-history, browser-shots, browser-*);
//   - ".8gent" with a glob, a $variable or browser/token/control/profile after it;
//   - a directory listing (readdir, listdir, ls, find, glob...) of ".8gent" itself or of a browser-* child
//     of it; a listing deeper inside .8gent (a pilot run dir) is not a listing of the secrets;
//   - any glob segment, other than a bare "*", that could expand to one of those names.

const SECRET_NAMES = [
	".8gent",
	"browser-control.token",
	"browser-control.port",
	"browser-profiles",
];

/** A shell glob segment as a regex: * ? [..] and {a,b} (treated as a wildcard). */
function globRe(seg: string): RegExp {
	let re = "";
	for (let i = 0; i < seg.length; i++) {
		const c = seg[i];
		const close = c === "[" ? seg.indexOf("]", i + 1) : c === "{" ? seg.indexOf("}", i + 1) : -1;
		if (c === "*") re += ".*";
		else if (c === "?") re += ".";
		else if (c === "[" && close > 0) {
			const body = seg
				.slice(i + 1, close)
				.replace(/^!/, "^")
				.replace(/[\\\]]/g, "\\$&");
			re += `[${body}]`;
			i = close;
		} else if (c === "{" && close > 0) {
			re += ".*";
			i = close;
		} else re += c.replace(/[.+^$()|[\]{}\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

/** The command as a reader would see it: as written, plus escapes, base64/hex literals and
 *  String.fromCharCode / chr() lists decoded. */
function decodedViews(command: string): string[] {
	const views = [command];
	// %xx (URL-style) escapes, so %62rowser-history cannot hide a name.
	if (/%[0-9a-f]{2}/i.test(command))
		views.push(
			command.replace(/%([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16))),
		);
	views.push(
		command
			.replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
			.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(Number.parseInt(h, 16)))
			.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(Number.parseInt(o, 8))),
	);
	for (const t of command.match(/[A-Za-z0-9+/_-]{12,}={0,2}/g) ?? [])
		views.push(Buffer.from(t, "base64").toString("latin1"));
	for (const t of command.match(/(?:[0-9a-f]{2}){8,}/gi) ?? [])
		views.push(Buffer.from(t, "hex").toString("latin1"));
	for (const m of command.matchAll(/(?:fromCharCode|chr)\s*\(([\d\s,]+)\)/g))
		views.push(String.fromCharCode(...m[1].split(",").map((n) => Number(n.trim()))));
	return views;
}

/** Short flags of grep/rg that take no value, so the first word after them is the pattern. */
const PLAIN_SHORT = /^-[rRhHnioEFwvcIsaqzPxlLu]+$/;

/**
 * For one pipeline segment that runs sed with plain flags: blank the quoted s/// script (#4417). Its
 * regex (`.*`, `[A-Za-z]*:`) is a pattern, not a shell glob, and read as one it matched ".8gent", so a
 * sed over .tmp/login was refused as browser state. Only the glob check sees the blanked view; the
 * .8gent and browser-* name checks still read the script as written. Any other shape is left as is.
 * Blanks at most the first quoted s/// word; `-e a -e b` forms and e/w flags are judged as written (fail-safe).
 */
function blankSedScript(seg: string): string {
	if (/\$\(|`|<\(/.test(seg) || !/^[\s;|&]*sed\s/.test(seg)) return seg;
	const words = [...seg.matchAll(/(?:'[^']*'|"[^"]*"|\S)+/g)];
	for (let i = 1; i < words.length; i++) {
		const w = words[i];
		if (/^-[nEr]+$/.test(w[0])) continue;
		const q = w[0];
		const m = /^'s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gipIm0-9]*'$/.exec(q);
		if (!m || /\.8|browser/i.test(q)) return seg;
		const at = w.index ?? 0;
		return seg.slice(0, at) + " ".repeat(q.length) + seg.slice(at + q.length);
	}
	return seg;
}

/**
 * For one pipeline segment that runs grep or rg: blank the quoted pattern (the first non-option word),
 * and only when every option before it is a plain no-value flag. Any other option (--include, -g, -e,
 * -f, --pre, anything with "=") or any $( ` <( in the segment leaves the segment untouched, so it is
 * judged as written. Unknown shapes therefore fail closed.
 */
function blankSearchPattern(seg: string): string {
	if (/\$\(|`|<\(/.test(seg) || !/^[\s;|&]*(?:grep|egrep|fgrep|rg)\s/.test(seg)) return seg;
	const words = [...seg.matchAll(/(?:'[^']*'|"[^"]*"|\S)+/g)];
	for (let i = 1; i < words.length; i++) {
		const w = words[i];
		if (w[0].startsWith("-")) {
			if (PLAIN_SHORT.test(w[0]) || w[0] === "--hidden") continue;
			return seg;
		}
		const q = w[0];
		if (!/^(?:'[^']*'|"[^"]*")$/.test(q) || /\/|\.8|browser/i.test(q)) return seg;
		const at = w.index ?? 0;
		return seg.slice(0, at) + " ".repeat(q.length) + seg.slice(at + q.length);
	}
	return seg;
}

/** The browser state under .8gent: the control token and port, the profiles, the history and the shots. */
const BROWSER_STATE_NAME = /browser-(control|profiles|history|shots)/;

/** The command split on shell separators (quotes already stripped by the caller). */
const shellTokens = (lower: string) => lower.split(/[\s;|&()<>=]+/);

/**
 * For a token holding .8gent: the posix-normalised path from its last .8gent on, with the .8gent
 * directory name stripped ("" is the directory itself). null when normalising removed .8gent
 * (x/.8gent/..), which every caller treats as fail closed.
 */
function tailUnder8gent(tok: string): string | null {
	const n = pathPosix.normalize(tok.replace(/\\/g, "/"));
	const at = n.lastIndexOf(".8gent");
	return at < 0 ? null : n.slice(at).replace(/^\.8gent[^/]*\/*/, "");
}

/**
 * Per-token check for browser state under .8gent. Every token holding .8gent is posix-normalised (so ./,
 * //, and x/.. cannot hide a browser-* name) and judged from its last .8gent on; a token that normalises
 * .8gent away fails closed. A token without .8gent is refused only when it names the browser state
 * (cd ~/.8gent && cat ./browser-history.json, ../browser-shots, a symlink alias); a name that merely
 * starts with "browser" (the pilot run dir browser-op-practice/) is a path, not state. Only a
 * browser-named directory deeper inside an .8gent path (.../runs/x/browser-op-practice/) is allowed.
 */
function browserUnder8gent(lower: string): boolean {
	for (const tok of shellTokens(lower)) {
		if (tok.includes(".8gent")) {
			const tail = tailUnder8gent(tok);
			if (tail === null || /^browser/.test(tail)) return true;
		} else if (BROWSER_STATE_NAME.test(tok)) return true;
	}
	return false;
}

/**
 * True when a token names the .8gent directory itself (~/.8gent, ~/.8gent/, ~/.8gent/x/.., the
 * os.listdir argument) or a browser-* child of it. A path deeper inside .8gent
 * (~/.8gent/rishi-pilot/runs/...) is not the secrets' directory, so listing it is allowed. A relative
 * step up in the same command (cd ~/.8gent/x/runs; ls ../..) cannot be resolved per token and fails closed.
 */
function names8gentDir(lower: string): boolean {
	for (const tok of shellTokens(lower)) {
		if (!tok.includes(".8gent")) {
			if (/(^|\/)\.\.(\/|$)/.test(tok)) return true;
			continue;
		}
		const tail = tailUnder8gent(tok);
		if (tail === null || tail === "" || /^browser-/.test(tail)) return true;
	}
	return false;
}

/** True when `command` looks like it reads or lists the 8gent Browser token or profile dirs. */
export function touchesBrowserSecrets(command: string): boolean {
	const lists =
		/readdir|listdir|scandir|os\.walk|glob|\bls\b|\bfind\b|\brg\b|\bgrep\b[^;|&]*(?:\s-[a-z]*r|\s--(?:dereference-)?recursive|\s-d\s*recurse|\s--directories[= ]\s*recurse)/i.test(
			command,
		);
	for (const view of decodedViews(command)) {
		// Strip quoting, escapes and JS/Python concatenation: ~/".8"gent, 'browser'-'control', '.8'+'gent'.
		const flat = view.replace(/["'`\\]/g, "").replace(/\s*\+\s*/g, "");
		const lower = flat.toLowerCase();
		if (/browser-(control|profiles|history|shots|[*?[{$])/.test(lower)) return true;
		const at = lower.indexOf(".8gent");
		if (at >= 0) {
			if (/[*?[{$]|token|control|profile/.test(lower.slice(at)) || browserUnder8gent(lower))
				return true;
			// A listing is refused when it is of .8gent itself or a browser-* child, not of any path under it.
			if (lists && names8gentDir(lower)) return true;
		}
		// A quoted PATTERN given to grep/rg is a regex, not a shell glob: grep 'value=[a-f0-9]*' must not read
		// as a glob over browser-control.token. Only that one word is blanked (see blankSearchPattern);
		// option values, find/sed/awk and anything with a substitution keep their globs.
		const shellView = view
			.split(/(?<=[;|&\n])/)
			.map(blankSearchPattern)
			.map(blankSedScript)
			.join("")
			.replace(/["'`\\]/g, "")
			.replace(/\s*\+\s*/g, "");
		for (const token of shellView.split(/[\s;|&()<>=]+/)) {
			if (!/[*?[{]/.test(token)) continue;
			for (const seg of token.split("/")) {
				if (seg === "*" || !/[*?[{]/.test(seg)) continue;
				const re = globRe(seg);
				if (SECRET_NAMES.some((n) => re.test(n))) return true;
			}
		}
	}
	return false;
}

/** Password, payment, PIN and OTP fields. Under a named profile no step types into one
 *  (#3622). Kept identical to 8gent-browser src/main/secret-fields.ts, which also checks
 *  label text in the page on the exact element. Refusing too much is the safe direction. */
const SECRET_FIELDS = [
	"input[type=password]",
	...[
		"current-password",
		"new-password",
		"one-time-code",
		"cc-name",
		"cc-given-name",
		"cc-additional-name",
		"cc-family-name",
		"cc-number",
		"cc-exp",
		"cc-exp-month",
		"cc-exp-year",
		"cc-csc",
		"cc-type",
	].map((t) => `[autocomplete~="${t}" i]`),
	'[autocomplete^="cc-" i]',
	...[
		"pass",
		"pwd",
		"pin",
		"otp",
		"one-time",
		"ssn",
		"exp",
		"ccnum",
		"cardnumber",
		"card",
		"cvc",
		"cvv",
		"csc",
		"iban",
		"security-code",
		"securitycode",
	].flatMap((t) => [`[name*="${t}" i]`, `[id*="${t}" i]`]),
	...[
		"password",
		"passcode",
		"card",
		"cvv",
		"cvc",
		"security code",
		"iban",
		"one-time",
		"pin",
	].flatMap((t) => [`[aria-label*="${t}" i]`, `[placeholder*="${t}" i]`]),
	"[contenteditable]",
].join(",");

/** PNG dimensions from the IHDR chunk (width and height at bytes 16-23, big-endian), or null. */
export function pngSize(png: Buffer): { w: number; h: number } | null {
	if (png.length < 24 || png.toString("latin1", 1, 4) !== "PNG") return null;
	if (png.toString("latin1", 12, 16) !== "IHDR") return null;
	const w = png.readUInt32BE(16);
	const h = png.readUInt32BE(20);
	return w > 0 && h > 0 ? { w, h } : null;
}

/** The role a model acts on, from the ARIA role when the browser reports one, else the tag. */
function roleOf(tag: string, role?: string): string {
	if (role) return role.toLowerCase();
	switch (tag) {
		case "a":
			return "link";
		case "button":
		case "summary":
			return "button";
		case "select":
			return "combobox";
		case "input":
		case "textarea":
			return "textbox";
		default:
			return tag || "element";
	}
}

export function createEightBrowser(
	callArg?: BrowserCall,
	/** isolated: a named profile (#3622). No typing into secret fields, no private hosts. */
	opts: {
		settleMs?: number;
		isolated?: boolean | (() => boolean);
		/** Loopback host:port the task may open (default: EIGHT_BROWSER_ALLOW_LOOPBACK). Ignored in a named profile. */
		allowLoopback?: string[];
		/** DNS resolver, injectable for tests. */
		resolve?: Resolver;
		/** Secrets file for {{secret:NAME}} placeholders (default EIGHT_BROWSER_SECRETS_FILE; "" disables). */
		secretsFile?: string;
		/** The run's workspace, only to report a workspace allow-loopback.json that was ignored: in an
		 *  isolated profile loopback is reachable only on trusted listed ports (EIGHT_BROWSER_ALLOW_LOOPBACK
		 *  or ~/.8gent/allow-loopback.json, #3785, 8SO). */
		workspace?: string | (() => string | undefined);
		/** Environment for the allowlist and profile rules (default process.env). */
		env?: Env;
	} = {},
) {
	const isolated = () => (typeof opts.isolated === "function" ? opts.isolated() : !!opts.isolated);
	const env = () => opts.env ?? process.env;
	const workspace = () =>
		typeof opts.workspace === "function" ? opts.workspace() : opts.workspace;
	const call: BrowserCall = callArg ?? wsTransport({ env: opts.env });
	const settle = opts.settleMs ?? 400;
	/** Isolated profile: is `url` one of the run's own loopback servers (trusted list only)? */
	const ownLoopback = (url: string): boolean =>
		isolated() && isAllowedLoopbackUrl(url, env(), profileHomeOverride ?? homedir());
	const ignoredNote = () => ignoredWorkspaceAllowlist(workspace());
	const destinationBlocked = async (url: string) => {
		if (ownLoopback(url)) return null;
		const why = await blockedBrowserDestination(url, {
			allowLoopback: isolated() ? [] : (opts.allowLoopback ?? loopbackAllowlist()),
			resolve: opts.resolve ?? testResolver ?? undefined,
		});
		// A repo's own allow-loopback.json is never trusted; say it was ignored rather than stay silent.
		const ignored = why && isolated() ? ignoredNote() : null;
		return ignored ? `${why} ${ignored}` : why;
	};
	/** The default local profile (#3785) never reads a secrets file: nothing in ~/.8gent is its to use. */
	const secretsFile = () => (usingDefaultLocalProfile(env()) ? "" : opts.secretsFile);
	/** Does `selector` reach a password, payment or contenteditable field? Asked of the page
	 *  itself, so it holds for any selector. Fails closed: an error reply (a malformed
	 *  selector) or anything but an elements array counts as secret. */
	const secretField = async (tabId: string, selector: string): Promise<boolean> => {
		const r = await call("page.query", {
			tabId,
			selector: `:is(${selector}):is(${SECRET_FIELDS})`,
		});
		if (!r || r.ok === false || !Array.isArray(r.elements)) return true;
		return r.elements.length > 0;
	};
	/** The same question for a type step by index: the element's rect must be a known, visible one,
	 *  and must not be among the page's secret fields. Fails closed on a missing or hidden element. */
	const secretIndex = async (tabId: string, els: El[], index: number): Promise<boolean> => {
		const el = els[index];
		if (!el || el.hidden || !el.rect) return true;
		return (await rects(tabId, SECRET_FIELDS)).has(JSON.stringify(el.rect));
	};
	/** 8gent Browser's page.type takes a selector only (control-server.ts: typeText(tab, selector, text));
	 *  an index is never read, so a type step by index must be turned into a selector first (#4426).
	 *  page.query reports no id or name, so candidates are built from what it does report (tag and
	 *  text, which is the value, aria-label or placeholder) and each is proved against the live page:
	 *  the first match in document order, which is what page.type hits, must have the target's rect. */
	const selectorForIndex = async (tabId: string, el: El): Promise<string | undefined> => {
		if (!el.rect || el.hidden || !(el.rect.w > 0) || !(el.rect.h > 0)) return undefined;
		if (!/^[a-z][a-z0-9-]*$/.test(el.tag)) return undefined;
		const want = JSON.stringify(el.rect);
		// Two elements sharing a rect cannot be told apart by where they are: refuse rather than guess.
		if ((await rectList(tabId)).filter((r) => r === want).length !== 1) return undefined;
		const q = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const candidates: string[] = [];
		if (el.text)
			for (const attr of ["placeholder", "aria-label", "name", "id", "title", "value"])
				candidates.push(`${el.tag}[${attr}="${q(el.text)}"]`);
		if (el.tag === "input")
			for (const t of ["password", "email", "text", "search", "tel", "url", "number"])
				candidates.push(`input[type=${t}]`);
		if (el.tag === "input") candidates.push("input:not([type])");
		for (let k = 1; k <= 8; k++) candidates.push(`${el.tag}:nth-of-type(${k})`);
		for (let k = 1; k <= 8; k++) candidates.push(`${el.tag}:nth-child(${k})`);
		for (const sel of candidates) {
			const r = await call("page.query", { tabId, selector: sel });
			const first = Array.isArray(r?.elements) ? r.elements[0] : undefined;
			if (first && JSON.stringify(first.rect) === want) return sel;
		}
		return undefined;
	};
	const owned = new Set<string>();
	const resolvedSecrets = new Map<string, string>(); // real value -> placeholder, for scrubbing output
	const scrub = (text: string): string => {
		let out = text;
		for (const [value, placeholder] of resolvedSecrets) out = out.split(value).join(placeholder);
		return out;
	};
	const typed = new Set<string>(); // clipped forms of text typed this session; page.query echoes input values
	let current: string | undefined;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const rectList = async (tabId: string, selector?: string): Promise<string[]> =>
		((await call("page.query", { tabId, selector }))?.elements ?? []).map((e: { rect?: Rect }) =>
			JSON.stringify(e.rect),
		);
	const rects = async (tabId: string, selector: string) =>
		new Set<string>(await rectList(tabId, selector));
	const elements = async (tabId: string): Promise<El[]> => {
		const r = await call("page.query", { tabId });
		const raw: Array<El & { visible?: boolean }> = r?.elements ?? [];
		// page.query has no checked flag; match :checked elements back by rect so a toggle click is observable.
		const on = await rects(tabId, ":checked");
		const pw = await rects(tabId, "input[type=password]"); // value is never rendered, typed by us or not
		// A browser that reports role and name per element (8gent-browser page.query) needs nothing more.
		// An older one does not: input types and ARIA roles are matched back by rect, so the list still
		// reads `[n] role "name"` the way the grounding lane expects (#4043).
		const reported = raw.every((e) => typeof e.role === "string");
		const roles: Array<[string, Set<string>]> = reported
			? []
			: [
					[
						"checkbox",
						await rects(
							tabId,
							"input[type=checkbox],[role=checkbox],input[type=radio],[role=radio]",
						),
					],
					[
						"button",
						await rects(
							tabId,
							"input[type=submit],input[type=button],input[type=reset],[role=button]",
						),
					],
					["link", await rects(tabId, "[role=link]")],
				];
		return raw.map((e) => {
			const key = JSON.stringify(e.rect);
			const byRect = e.rect ? roles.find(([, set]) => set.has(key))?.[0] : undefined;
			const el: El = {
				index: e.index,
				tag: e.tag,
				role: roleOf(e.tag, e.role ?? byRect),
				text: e.text,
				rect: e.rect,
			};
			if (typeof e.name === "string" && e.name.trim()) el.name = clipped(e.name);
			if (e.visible === false) el.hidden = true; // kept for stable indices, never rendered (hidden csrf values)
			if (e.rect && on.has(key)) el.checked = true;
			if (e.rect && pw.has(key)) el.secret = true;
			return el;
		});
	};
	const observe = async (tabId: string) => {
		const snap = (await call("page.read", { tabId }))?.snapshot ?? {};
		const els = await elements(tabId);
		const sig = createHash("sha256")
			.update(JSON.stringify([snap.url, snap.title, snap.text, els]))
			.digest("hex")
			.slice(0, 16);
		return {
			url: String(snap.url ?? ""),
			title: String(snap.title ?? ""),
			text: String(snap.text ?? ""),
			els,
			sig,
		};
	};
	const own = (tabId?: string): string => {
		const id = tabId ?? current;
		if (!id || !owned.has(id))
			throw new Error(`tab ${id ?? "(none)"} was not opened by 8gent; call browser_open first`);
		return id;
	};
	const render = (tab: string, o: Awaited<ReturnType<typeof observe>>) =>
		scrub(
			JSON.stringify({
				tab,
				url: o.url,
				title: o.title,
				elements: o.els
					.filter((e) => !e.hidden)
					.map(
						(e) =>
							`[${e.index}] ${e.role ?? roleOf(e.tag)} ${label(e)}${e.checked ? " (checked)" : ""}`,
					),
				text: o.text.slice(0, 3_000),
			}),
		);
	const shown = (e: El) =>
		e.secret ? "(password field)" : typed.has(e.text) ? `(typed, ${e.text.length} chars)` : e.text;
	/** The element's accessible name, quoted: the browser's computed name when it reports one (never a
	 *  field's value), else its text. A password field's or a typed value's text is never shown. */
	const label = (e: El) => {
		if (e.name && !typed.has(e.name))
			return `${JSON.stringify(e.name)}${e.secret ? " (password field)" : ""}`;
		return e.secret || typed.has(e.text) ? shown(e) : JSON.stringify(e.text);
	};
	const indexGuard = (els: El[], index?: number): string | null => {
		if (index === undefined) return null;
		if (!els[index]) return `index ${index} out of range (${els.length} elements)`;
		return els[index].hidden ? `index ${index} is a hidden element` : null;
	};
	/** Resolve a click to the element it will hit (page.click uses the first selector match), refuse
	 *  hidden or missing targets, and send a sensitive one (by text, or by aria-label / title / value /
	 *  name attribute) to the approver. Returns the target's display text, or an error. */
	const clickTarget = async (
		id: string,
		els: El[],
		a: { index?: number; selector?: string },
		approve?: ApproveFn,
	) => {
		let el: El | undefined;
		if (a.index !== undefined) {
			const err = indexGuard(els, a.index);
			if (err) return { error: err };
			el = els[a.index];
		} else {
			const q = (await call("page.query", { tabId: id, selector: a.selector }))?.elements?.[0];
			if (!q) return { error: `no element matched selector ${a.selector}` };
			if (q.visible === false) return { error: `selector ${a.selector} is a hidden element` };
			el = els.find((e) => JSON.stringify(e.rect) === JSON.stringify(q.rect)) ?? {
				index: -1,
				tag: q.tag,
				text: String(q.text ?? ""),
				rect: q.rect,
			};
		}
		let cat = sensitiveCategory(el.text);
		for (const [c, terms] of SENSITIVE) {
			if (cat) break;
			const sel = terms
				.flatMap((t) => ["aria-label", "title", "value", "name"].map((k) => `[${k}*="${t}" i]`))
				.join(",");
			if ((await rects(id, sel)).has(JSON.stringify(el.rect))) cat = c;
		}
		const text = shown(el);
		if (cat) {
			const what = `click "${text}" (${cat})`;
			if (!approve) return { error: `${what} needs approval; ask the person` };
			if (!(await approve(what))) return { error: `${what} was declined; nothing clicked` };
		}
		return { text };
	};

	async function open(url: string): Promise<string> {
		const v = validateBrowserAction(
			{ action: "open", url },
			{ isolated: isolated(), allowedLoopback: ownLoopback, refusalNote: ignoredNote },
		);
		if (!v.ok) return `browser_open failed: ${v.error}`;
		const blocked = await destinationBlocked(url);
		if (blocked) return `browser_open failed: ${blocked}`;
		const r = await call("tab.open", { url });
		owned.add((current = String(r.id)));
		await call("page.waitFor", { tabId: current, selector: "body", timeoutMs: 10_000 });
		return render(current, await observe(current));
	}

	async function state(tabId?: string): Promise<string> {
		try {
			const id = own(tabId);
			return render(id, await observe(id));
		} catch (e) {
			return `browser_state failed: ${(e as Error).message}`;
		}
	}

	async function run(raw: unknown[], tabId?: string, approve?: ApproveFn): Promise<string> {
		try {
			return scrub(await runSteps(raw, tabId, approve));
		} catch (e) {
			// A transport error can echo what was typed; scrub it like returned output.
			throw new Error(scrub(e instanceof Error ? e.message : String(e)));
		}
	}

	async function runSteps(raw: unknown[], tabId?: string, approve?: ApproveFn): Promise<string> {
		const fail = (error: string, steps: unknown[] = []) =>
			JSON.stringify({ ok: false, error, steps });
		let id: string;
		try {
			id = own(tabId);
		} catch (e) {
			return fail((e as Error).message);
		}
		if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.maxSteps)
			return fail(`actions must be 1..${LIMITS.maxSteps} steps`);
		// Dry run: validate every step, resolve clicks up to the first page-changing step.
		const plan: BrowserAction[] = [];
		let before = await observe(id);
		for (const [i, r] of raw.entries()) {
			const v = validateBrowserAction(r, {
				isolated: isolated(),
				allowedLoopback: ownLoopback,
				refusalNote: ignoredNote,
			});
			if (!v.ok) return fail(`dry run: step ${i}: ${v.error}`);
			if (v.action.action === "open") {
				const blocked = await destinationBlocked(v.action.url);
				if (blocked) return fail(`dry run: step ${i}: ${blocked}`);
			}

			if (v.action.action === "type" && hasSecretPlaceholder(v.action.text)) {
				const r = resolveSecretText(v.action.text, before.url, secretsFile(), workspace());
				if (!r.ok) return fail(`dry run: step ${i}: ${r.error}`);
			}
			plan.push(v.action);
		}
		type TypeStep = Extract<BrowserAction, { action: "type" }>;
		const typeTarget = (a: TypeStep) => a.selector ?? `index ${a.index}`;
		const refuseSecret = (i: number, a: TypeStep) =>
			fail(
				`step ${i}: ${typeTarget(a)} is a password or payment field; this browser profile types into one only on the run's own listed loopback server`,
				steps,
			);
		const steps: Record<string, unknown>[] = [];
		/** Secret-field check for a type step, by selector or by index. */
		const secretTarget = (a: TypeStep, els: El[]) =>
			a.selector !== undefined
				? secretField(id, a.selector)
				: secretIndex(id, els, a.index as number);
		// Isolated profile: a password or payment field is typed into only on an allowed loopback page,
		// the run's own test server (#3785). The dry run judges by where the plan will be; the live
		// check below judges by where the page is.
		if (isolated()) {
			let planUrl = before.url;
			for (const [i, a] of plan.entries()) {
				if (a.action === "open") planUrl = a.url;
				if (a.action !== "type") continue;
				if (a.index !== undefined) {
					const err = indexGuard(before.els, a.index);
					if (err) return fail(`dry run: step ${i}: ${err}`);
				}
				if (!ownLoopback(planUrl) && (await secretTarget(a, before.els))) return refuseSecret(i, a);
			}
		}
		for (const [i, a] of plan.entries()) {
			if (a.action === "open") break;
			if (a.action === "type" && a.index !== undefined) {
				const err = indexGuard(before.els, a.index);
				if (err) return fail(`dry run: step ${i}: ${err}`);
				continue;
			}
			if (a.action !== "left_click") continue;
			const err = indexGuard(before.els, a.index);
			if (err) return fail(`dry run: step ${i}: ${err}`);
			break; // after the first click the page may change; later clicks are re-resolved live
		}
		for (const [i, a] of plan.entries()) {
			const row: Record<string, unknown> = { step: i, action: a.action, attempts: 1 };
			if (a.action === "type") {
				// Re-checked live: an earlier step may have changed the page since the dry run.
				if (a.index !== undefined) {
					const err = indexGuard(before.els, a.index);
					if (err) return fail(`step ${i}: ${err}`, steps);
					row.index = a.index;
				} else row.selector = a.selector;
				if (isolated() && !ownLoopback(before.url) && (await secretTarget(a, before.els)))
					return refuseSecret(i, a);
				row.text_len = a.text.length;
				let text = a.text;
				if (hasSecretPlaceholder(a.text)) {
					// Resolved now, against the page as it is now: an earlier step may have moved it.
					const r = resolveSecretText(a.text, before.url, secretsFile(), workspace());
					if (!r.ok) return fail(`step ${i}: ${r.error}`, steps);
					text = r.text;
					for (const [placeholder, value] of r.values) resolvedSecrets.set(value, placeholder);
				}
				if (text) typed.add(clipped(text));
				const readBack = async (): Promise<unknown> =>
					a.selector !== undefined
						? (await call("page.query", { tabId: id, selector: a.selector }))?.elements?.[0]?.text
						: (await call("page.query", { tabId: id }))?.elements?.[a.index as number]?.text;
				// 8gent Browser never echoes a password or payment field's value in page.query: the text
				// comes back blank, or as the field's label or placeholder. Reading it back can then never
				// equal what was typed, so for those fields the check is that the type call succeeded and
				// the read-back is either the typed text (a browser that echoes) or unchanged from before
				// (a browser that hides it). A different value still fails. The typed text is compared
				// in memory only and never written to the step row.
				// page.type reads only a selector: an index step is sent as the selector that reaches the same element.
				let typeSelector = a.selector;
				if (typeSelector === undefined) {
					typeSelector = await selectorForIndex(id, before.els[a.index as number]);
					if (typeSelector === undefined)
						return fail(
							`step ${i}: index ${a.index} has no selector 8gent Browser can type into; address it with a selector, for example {selector:"input[type=password]"}`,
							steps,
						);
				}
				const hidden = await secretTarget(a, before.els);
				const preText = hidden ? await readBack() : undefined;
				for (let n = 1; n <= 2; n++) {
					row.attempts = n;
					const r = await call("page.type", {
						tabId: id,
						selector: typeSelector,
						text,
					});
					if (r?.ok === false) row.error = r.error;
					const got = await readBack();
					row.verified =
						got === clipped(text) ||
						(hidden &&
							r?.ok === true &&
							typeof got === "string" &&
							typeof preText === "string" &&
							got === preText);
					if (row.verified) break;
				}
				row.ok = row.verified;
			} else if (a.action === "left_click") {
				const target = await clickTarget(id, before.els, a, approve);
				if ("error" in target) return fail(`step ${i}: ${target.error}`, steps);
				row.target = target.text;
				const r = await call("page.click", { tabId: id, index: a.index, selector: a.selector });
				row.ok = r?.ok !== false;
				if (!row.ok) row.error = r.error;
				let after = await observe(id);
				for (let n = 0; row.ok && after.sig === before.sig && n < 3; n++) {
					await sleep(settle);
					after = await observe(id);
				}
				row.verified = row.ok && after.sig !== before.sig; // no visible change is reported, never retried
				before = after;
				steps.push(row);
				if (!row.ok) return fail(`step ${i}: click failed`, steps);
				continue;
			} else if (a.action === "open") {
				await call("nav.go", { tabId: id, url: a.url });
				row.verified = row.ok =
					(await call("page.waitFor", { tabId: id, selector: "body", timeoutMs: 10_000 }))
						?.found === true;
			} else if (a.action === "wait_for") {
				row.verified = row.ok =
					(await call("page.waitFor", { tabId: id, selector: a.selector, timeoutMs: a.timeout_ms }))
						?.found === true;
			} else {
				const r = await call("page.scroll", { tabId: id, dy: a.dy });
				row.verified = row.ok = r?.ok !== false;
			}
			steps.push(row);
			if (!row.ok) return fail(`step ${i}: ${a.action} not verified`, steps);
			before = await observe(id);
		}
		return JSON.stringify({ ok: true, steps, page: JSON.parse(render(id, before)) });
	}

	/** Screenshot an owned tab to `path` (default: 8gent Browser's own ~/.8gent/browser-shots file).
	 *  Returns `<absolute png path> <W>x<H>`, the size read from the PNG header (or the browser's
	 *  reported viewport), so a grounding model can map coordinates without opening the file. */
	async function screenshot(path?: string, tabId?: string): Promise<string> {
		try {
			const r = await call("page.screenshot", { tabId: own(tabId) });
			if (r?.ok === false) return `browser_screenshot failed: ${r.error}`;
			const png =
				typeof r?.dataUrl === "string"
					? Buffer.from(r.dataUrl.replace(/^data:image\/\w+;base64,/, ""), "base64")
					: null;
			let file: string;
			if (path) {
				if (!png) return "browser_screenshot failed: 8gent Browser sent no image";
				writeFileSync(path, png);
				file = resolvePath(path);
			} else {
				if (!r?.savedTo) return "browser_screenshot failed: 8gent Browser saved no file";
				file = resolvePath(String(r.savedTo));
			}
			let size = png ? pngSize(png) : null;
			if (!size) {
				try {
					size = pngSize(readFileSync(file));
				} catch {}
			}
			const vp = r?.viewport;
			if (!size && vp && Number.isInteger(vp.width) && Number.isInteger(vp.height))
				size = { w: vp.width, h: vp.height };
			return size ? `${file} ${size.w}x${size.h}` : file;
		} catch (e) {
			return `browser_screenshot failed: ${(e as Error).message}`;
		}
	}

	/** Close every tab this driver opened (session end). Never touches other tabs. */
	async function closeAll(): Promise<void> {
		for (const id of owned) await call("tab.close", { id }).catch(() => null);
		owned.clear();
		current = undefined;
	}

	return { open, state, run, screenshot, closeAll };
}
