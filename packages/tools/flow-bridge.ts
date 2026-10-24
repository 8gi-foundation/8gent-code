/**
 * Flow bridge client (#4944). On an Android phone the 8gent Flow app has a Browser tab. When the
 * person has paired this terminal with it, web_fetch asks that tab to open the page and read it,
 * so browsing goes through the owned app instead of an outside client.
 *
 * What it does and does not do:
 *  - It talks to 127.0.0.1 only. The host is a constant here, not read from the pairing file.
 *  - Pairing is one question that defaults to No, and unattended means No. A No writes nothing.
 *  - Nothing is installed. Flow absent, not paired, not Android, or any error: bridgeFetch returns
 *    null and web_fetch runs its normal path, unchanged and silent.
 *  - The token lives in ~/.8gent/flow-bridge.json (0600). It is never printed; only its last four
 *    characters are shown, so the person can match them against the sheet in Flow.
 *
 * Wire: GET /v1/ping, POST /v1/open {url, max_bytes} -> {ok, url, title, text, truncated}, both with
 * "Authorization: Bearer <token>". The server side is src-tauri/src/bridge.rs in 8gent-flow.
 */

import { randomBytes, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveHome } from "../core/home";
import { type Ask, defaultAsk } from "../cron/scout";
import { isAndroidHost } from "../voice/termux";

export const PAIRING_FILE = "flow-bridge.json";
const LOOPBACK = "127.0.0.1";
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

type Env = Record<string, string | undefined>;

export interface Pairing {
	port: number;
	token: string;
}

export interface FlowDeps {
	env?: Env;
	platform?: string;
	/** Where the pairing file lives. Default ~/.8gent. */
	dir?: string;
	fetchImpl?: typeof fetch;
	ask?: Ask;
	/** Hand the pairing link to Android (termux-open-url). */
	openLink?: (link: string) => Promise<void>;
	say?: (line: string) => void;
	pingTimeoutMs?: number;
	openTimeoutMs?: number;
	confirmTimeoutMs?: number;
	pollMs?: number;
}

const dirOf = (d: FlowDeps) => d.dir ?? path.join(resolveHome(d.env ?? process.env), ".8gent");
const onAndroid = (d: FlowDeps) =>
	isAndroidHost(d.platform ?? process.platform, d.env ?? process.env);

// ── pairing file ─────────────────────────────────────────────────────────

export function newPairing(): Pairing {
	return { port: randomInt(20000, 60000), token: randomBytes(32).toString("base64url") };
}

export function pairingLink(p: Pairing): string {
	return `eightgent://bridge?p=${p.port}&t=${p.token}`;
}

export function writePairing(p: Pairing, dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, PAIRING_FILE);
	fs.writeFileSync(file, JSON.stringify({ port: p.port, token: p.token }), { mode: 0o600 });
	fs.chmodSync(file, 0o600);
}

/** The pairing, or null for no file or any file that is not exactly the shape we write. */
export function readPairing(dir: string): Pairing | null {
	try {
		const v = JSON.parse(fs.readFileSync(path.join(dir, PAIRING_FILE), "utf8"));
		if (!v || typeof v !== "object" || Array.isArray(v)) return null;
		const { port, token } = v as Record<string, unknown>;
		if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) return null;
		if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
		return { port: port as number, token };
	} catch {
		return null;
	}
}

export function clearPairing(dir: string): void {
	fs.rmSync(path.join(dir, PAIRING_FILE), { force: true });
}

// ── requests ─────────────────────────────────────────────────────────────

async function call(
	p: Pairing,
	route: string,
	init: { method: "GET" | "POST"; body?: string },
	ms: number,
	f: typeof fetch,
): Promise<Response | null> {
	try {
		return await f(`http://${LOOPBACK}:${p.port}${route}`, {
			method: init.method,
			headers: {
				Authorization: `Bearer ${p.token}`,
				...(init.body ? { "Content-Type": "application/json" } : {}),
			},
			body: init.body,
			redirect: "manual",
			signal: AbortSignal.timeout(ms),
		});
	} catch {
		return null;
	}
}

async function ping(p: Pairing, ms: number, f: typeof fetch): Promise<boolean> {
	const r = await call(p, "/v1/ping", { method: "GET" }, ms, f);
	if (!r || r.status !== 200) return false;
	try {
		return ((await r.json()) as { ok?: unknown }).ok === true;
	} catch {
		return false;
	}
}

export interface BridgeResult {
	title: string;
	url: string;
	content: string;
	length: number;
}

/**
 * Ask Flow to open `url` and return its text, or null for "use the normal path". Null covers every
 * reason: not Android, no pairing, Flow not answering, a revoked token, a refusal, a bad answer.
 */
export async function bridgeFetch(
	url: string,
	opts: { maxLength?: number },
	deps: FlowDeps = {},
): Promise<BridgeResult | null> {
	if (!onAndroid(deps)) return null;
	const p = readPairing(dirOf(deps));
	if (!p) return null;
	const f = deps.fetchImpl ?? fetch;
	if (!(await ping(p, deps.pingTimeoutMs ?? 300, f))) return null;
	const maxLength = opts.maxLength ?? 50000;
	const r = await call(
		p,
		"/v1/open",
		{ method: "POST", body: JSON.stringify({ url, max_bytes: maxLength }) },
		deps.openTimeoutMs ?? 20000,
		f,
	);
	if (!r || r.status !== 200) return null;
	try {
		const v = (await r.json()) as Record<string, unknown>;
		if (v.ok !== true || typeof v.text !== "string") return null;
		return {
			title: typeof v.title === "string" && v.title ? v.title : url,
			url: typeof v.url === "string" && v.url ? v.url : url,
			content: v.text.slice(0, maxLength),
			length: v.text.length,
		};
	} catch {
		return null;
	}
}

// ── pairing flow and command ─────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function termuxOpenUrl(link: string): Promise<void> {
	const proc = Bun.spawn(["termux-open-url", link], { stdout: "ignore", stderr: "ignore" });
	await proc.exited;
}

export const PAIR_QUESTION =
	"Let the 8gent Flow app on this phone open and read web pages for this terminal? It stays on this phone. [y/N]";

/** Returns the exit code: 0 paired, 1 nothing changed. */
export async function pairFlow(deps: FlowDeps = {}): Promise<number> {
	const say = deps.say ?? ((l: string) => console.log(l));
	const dir = dirOf(deps);
	if (!onAndroid(deps)) {
		say("The Flow bridge is for Termux on Android. Nothing changed.");
		return 1;
	}
	const ask = deps.ask ?? defaultAsk(deps.env ?? process.env);
	const yes = await ask(PAIR_QUESTION, false);
	if (yes !== true) {
		say("Not paired. Nothing was saved.");
		return 1;
	}
	const p = newPairing();
	writePairing(p, dir);
	const open = deps.openLink ?? termuxOpenUrl;
	try {
		await open(pairingLink(p));
	} catch {
		clearPairing(dir);
		say("Could not open the pairing link on this phone. Nothing was paired.");
		return 1;
	}
	say(
		`Flow is asking you to allow this. Check that the code ends in ${p.token.slice(-4)}, then tap Allow.`,
	);
	const f = deps.fetchImpl ?? fetch;
	const until = Date.now() + (deps.confirmTimeoutMs ?? 60000);
	while (Date.now() < until) {
		if (await ping(p, 300, f)) {
			say("Paired. web_fetch on this phone now reads pages through the Flow Browser tab.");
			return 0;
		}
		await sleep(deps.pollMs ?? 1000);
	}
	clearPairing(dir);
	say("Flow did not confirm. Nothing was paired.");
	return 1;
}

const USAGE = "Usage: 8gent flow pair | status | unpair";

export async function runFlowCommand(args: string[], deps: FlowDeps = {}): Promise<number> {
	const say = deps.say ?? ((l: string) => console.log(l));
	const dir = dirOf(deps);
	switch (args[0]) {
		case "pair":
			return pairFlow(deps);
		case "status": {
			const p = readPairing(dir);
			if (!p) {
				say("Flow bridge: not paired. web_fetch uses its normal path.");
				return 0;
			}
			const live = await ping(p, deps.pingTimeoutMs ?? 300, deps.fetchImpl ?? fetch);
			say(
				live
					? "Flow bridge: paired and Flow is answering."
					: "Flow bridge: paired, but Flow is not answering right now. web_fetch uses its normal path.",
			);
			return 0;
		}
		case "unpair":
			clearPairing(dir);
			say("Unpaired. web_fetch uses its normal path. You can also turn it off in Flow.");
			return 0;
		default:
			say(USAGE);
			return 2;
	}
}
