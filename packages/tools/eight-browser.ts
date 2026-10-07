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
 * ~/.8gent/browser-profiles/<name>/), never the person's logged-in default profile. A bad name, or a profile
 * that is not running, is an error: there is no fallback to the default token or port 7980.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type BrowserCall = (cmd: string, args?: Record<string, unknown>) => Promise<any>;
export type BrowserAction =
	| { action: "open"; url: string }
	| { action: "left_click"; index?: number; selector?: string }
	| { action: "type"; selector: string; text: string }
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

export function validateBrowserAction(
	raw: unknown,
	opts: { isolated?: boolean } = {},
): Check<BrowserAction> {
	if (!raw || typeof raw !== "object") return { ok: false, error: "action must be an object" };
	const a = raw as Record<string, unknown>;
	const sel = typeof a.selector === "string" && a.selector.trim() ? a.selector : undefined;
	switch (a.action) {
		case "open": {
			if (typeof a.url !== "string" || !/^https?:\/\//.test(a.url))
				return { ok: false, error: "open.url must be http(s)" };
			const why = opts.isolated ? blockedForProfile(a.url) : null;
			if (why) return { ok: false, error: `open.url refused in this browser profile: ${why}` };
			return { ok: true, action: { action: "open", url: a.url } };
		}
		case "left_click": {
			const index =
				Number.isInteger(a.index) && (a.index as number) >= 0 ? (a.index as number) : undefined;
			if (index === undefined && !sel)
				return { ok: false, error: "left_click needs index or selector" };
			return { ok: true, action: { action: "left_click", index, selector: sel } };
		}
		case "type":
			if (!sel || typeof a.text !== "string")
				return { ok: false, error: "type needs selector and text" };
			if (a.text.length > LIMITS.maxTypeLength)
				return { ok: false, error: `type.text > ${LIMITS.maxTypeLength} chars` };
			return { ok: true, action: { action: "type", selector: sel, text: a.text } };
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

/**
 * The named 8gent Browser profile this process uses, or null for the default profile (unset, empty or
 * "default"). A name that is not a short lowercase slug throws: it never falls back to the default profile,
 * and since it cannot contain "/" or "." it can never resolve to the default token.
 */
export function browserProfile(
	env: Env = process.env,
	home: string = profileHomeOverride ?? homedir(),
): BrowserProfile | null {
	const name = env.EIGHT_BROWSER_PROFILE;
	if (name === undefined || name === "" || name === "default") return null;
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

/** Browser tools a local-model session may see: none unless a named profile is configured. */
export function localBrowserTools(env: Env = process.env): string[] {
	return isolatedBrowser(env)
		? ["browser_open", "browser_state", "browser_task", "browser_screenshot"]
		: [];
}

/** Where to connect: a named profile's own token and published port, else the default token and port. */
function endpoint(opts: { port?: number; tokenFile?: string; env?: Env }): {
	port: number;
	tokenFile: string;
	profile?: string;
} {
	const env = opts.env ?? process.env;
	const profile = browserProfile(env);
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
export function wsTransport(
	opts: { port?: number; tokenFile?: string; env?: Env } = {},
): BrowserCall {
	return (cmd, args = {}) => {
		let port: number;
		let tokenFile: string;
		try {
			({ port, tokenFile } = endpoint(opts));
		} catch (e) {
			return Promise.reject(e);
		}
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
//   - the token and profile names (browser-control, browser-profiles, browser-*);
//   - ".8gent" with a glob, a $variable or browser/token/control/profile after it;
//   - ".8gent" in a command that lists directories (readdir, listdir, ls, find, glob...);
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

/** True when `command` looks like it reads or lists the 8gent Browser token or profile dirs. */
export function touchesBrowserSecrets(command: string): boolean {
	const lists = /readdir|listdir|scandir|os\.walk|glob|\bls\b|\bfind\b/i.test(command);
	for (const view of decodedViews(command)) {
		// Strip quoting, escapes and JS/Python concatenation: ~/".8"gent, 'browser'-'control', '.8'+'gent'.
		const flat = view.replace(/["'`\\]/g, "").replace(/\s*\+\s*/g, "");
		const lower = flat.toLowerCase();
		if (/browser-(control|profiles|[*?[{$])/.test(lower)) return true;
		const at = lower.indexOf(".8gent");
		if (at >= 0) {
			if (/[*?[{$]|browser|token|control|profile/.test(lower.slice(at))) return true;
			if (lists) return true;
		}
		for (const token of flat.split(/[\s;|&()<>=]+/)) {
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

export function createEightBrowser(
	call: BrowserCall = wsCall,
	/** isolated: a named profile (#3622). No typing into secret fields, no private hosts. */
	opts: { settleMs?: number; isolated?: boolean | (() => boolean) } = {},
) {
	const isolated = () => (typeof opts.isolated === "function" ? opts.isolated() : !!opts.isolated);
	const settle = opts.settleMs ?? 400;
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
	const owned = new Set<string>();
	const typed = new Set<string>(); // clipped forms of text typed this session; page.query echoes input values
	let current: string | undefined;
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const rects = async (tabId: string, selector: string) =>
		new Set<string>(
			((await call("page.query", { tabId, selector }))?.elements ?? []).map((e: { rect?: Rect }) =>
				JSON.stringify(e.rect),
			),
		);
	const elements = async (tabId: string): Promise<El[]> => {
		const r = await call("page.query", { tabId });
		// page.query has no checked flag; match :checked elements back by rect so a toggle click is observable.
		const on = await rects(tabId, ":checked");
		const pw = await rects(tabId, "input[type=password]"); // value is never rendered, typed by us or not
		return (r?.elements ?? []).map((e: El & { visible?: boolean }) => {
			const el: El = { index: e.index, tag: e.tag, text: e.text, rect: e.rect };
			const key = JSON.stringify(e.rect);
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
		JSON.stringify({
			tab,
			url: o.url,
			title: o.title,
			elements: o.els
				.filter((e) => !e.hidden)
				.map((e) => `[${e.index}] ${e.tag}${e.checked ? " (checked)" : ""} ${shown(e)}`.trim()),
			text: o.text.slice(0, 3_000),
		});
	const shown = (e: El) =>
		e.secret ? "(password field)" : typed.has(e.text) ? `(typed, ${e.text.length} chars)` : e.text;
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
		const v = validateBrowserAction({ action: "open", url }, { isolated: isolated() });
		if (!v.ok) return `browser_open failed: ${v.error}`;
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
			const v = validateBrowserAction(r, { isolated: isolated() });
			if (!v.ok) return fail(`dry run: step ${i}: ${v.error}`);
			plan.push(v.action);
		}
		const refuseSecret = (i: number, sel: string) =>
			fail(
				`step ${i}: ${sel} is a password or payment field; this browser profile never types into one`,
				steps,
			);
		const steps: Record<string, unknown>[] = [];
		if (isolated())
			for (const [i, a] of plan.entries())
				if (a.action === "type" && (await secretField(id, a.selector)))
					return refuseSecret(i, a.selector);
		for (const [i, a] of plan.entries()) {
			if (a.action === "open") break;
			if (a.action !== "left_click") continue;
			const err = indexGuard(before.els, a.index);
			if (err) return fail(`dry run: step ${i}: ${err}`);
			break; // after the first click the page may change; later clicks are re-resolved live
		}
		for (const [i, a] of plan.entries()) {
			const row: Record<string, unknown> = { step: i, action: a.action, attempts: 1 };
			if (a.action === "type") {
				// Re-checked live: an earlier step may have changed the page since the dry run.
				if (isolated() && (await secretField(id, a.selector))) return refuseSecret(i, a.selector);
				row.selector = a.selector;
				row.text_len = a.text.length;
				if (a.text) typed.add(clipped(a.text));
				for (let n = 1; n <= 2; n++) {
					row.attempts = n;
					const r = await call("page.type", { tabId: id, selector: a.selector, text: a.text });
					if (r?.ok === false) row.error = r.error;
					const got = (await call("page.query", { tabId: id, selector: a.selector }))?.elements?.[0]
						?.text;
					row.verified = got === clipped(a.text);
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

	/** Screenshot an owned tab to `path` (default: 8gent Browser's own ~/.8gent/browser-shots file). */
	async function screenshot(path?: string, tabId?: string): Promise<string> {
		try {
			const r = await call("page.screenshot", { tabId: own(tabId) });
			if (r?.ok === false) return `browser_screenshot failed: ${r.error}`;
			if (!path)
				return String(r?.savedTo ?? "browser_screenshot failed: 8gent Browser saved no file");
			writeFileSync(
				path,
				Buffer.from(String(r?.dataUrl ?? "").replace(/^data:image\/\w+;base64,/, ""), "base64"),
			);
			return path;
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
